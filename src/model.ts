import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import pc from 'picocolors';
import { extractChatTxt, chatInfoFromZip } from './extract';
import { parseMessages } from './parse/message';
import { mergeCsv, readCsv, writeCsv } from './csv';
import { renderJson } from './render/json';
import { renderMarkdown } from './render/md';
import { renderHtml } from './render/html';
import { reconcileMedia } from './media';
import type { Detection } from './parse/timestamp';
import type { Message } from './parse/types';

export interface RunOptions {
  out?: string;
  dayFirst?: boolean;
  monthFirst?: boolean;
  verbose?: boolean;
  /** Embed resolved media as base64 `data:` URIs into a single HTML file. */
  inline?: boolean;
  /** Skip fetching webpage titles (offline). URL→title map stays empty. */
  noFetchTitles?: boolean;
}

/** D-07 — transparency report for the detected file format. */
export function verboseReport(
  detection: Detection,
  warnings: string[],
  count: number,
): void {
  const order = detection.dayFirst ? 'DAY/MM (dd/mm)' : 'MM/DAY (mm/dd)';
  // eslint-disable-next-line no-console
  console.error(
    pc.dim(`[wa-backup] format detection:`) +
      `\n  order : ${pc.cyan(order)}${detection.overridden ? pc.yellow(' (CLI override)') : ''}` +
      `\n  clock : ${pc.cyan(detection.is12h ? '12h (AM/PM)' : '24h')}` +
      (detection.example ? `\n  sample: ${pc.dim(detection.example)}` : ''),
  );
  if (warnings.length) {
    // eslint-disable-next-line no-console
    console.error(
      pc.yellow(`  warnings (${warnings.length}):`) +
        '\n    ' +
        warnings.slice(0, 10).join('\n    ') +
        (warnings.length > 10 ? `\n    … and ${warnings.length - 10} more` : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.error(pc.dim(`  parsed: ${count} messages`));
}

/**
 * Orchestrate the full vertical path:
 *   extractChatTxt -> detectFormat -> parseMessages -> writeCsv
 * writes `${out}/<chat>/messages.csv` and returns the message count.
 */
export interface RenderResult {
  json?: string;
  md?: string;
  html?: string;
}

/**
 * Render the three synchronized outputs (JSON / Markdown / HTML) from the
 * messages.csv source-of-truth in `dir` (D-20/D-21/D-22). Renderers re-read
 * the CSV from disk so old backups can be re-rendered without the original ZIP.
 */
export async function renderOutputs(
  dir: string,
  chatName: string,
  opts: { inline?: boolean } = {},
): Promise<RenderResult> {
  const csvPath = path.join(dir, 'messages.csv');
  if (!existsSync(csvPath)) return {};
  const result: RenderResult = {};
  result.json = await renderJson(csvPath, dir, chatName, opts);
  result.md = await renderMarkdown(csvPath, dir, chatName, opts);
  result.html = await renderHtml(csvPath, dir, chatName, opts);
  return result;
}

export async function runParser(
  zipPath: string,
  opts: RunOptions = {},
): Promise<number> {
  const { slug, name } = await chatInfoFromZip(zipPath);
  const out = opts.out ?? 'output';
  const dir = path.join(out, slug);
  await fs.mkdir(dir, { recursive: true });

  const lines = await extractChatTxt(zipPath);
  const warnings: string[] = [];
  let detection: Detection | undefined;
  const messages: Message[] = [];
  for await (const m of parseMessages(lines, {
    dayFirst: opts.dayFirst,
    monthFirst: opts.monthFirst,
    warnings,
    onDetection: (d) => {
      detection = d;
    },
  })) {
    messages.push(m);
  }

  // Incremental merge into the CSV source-of-truth (D-13/D-16/D-17):
  // re-runs dedupe against existing rows and keep the file sorted ascending.
  const added = await mergeCsv(path.join(dir, 'messages.csv'), messages);

  // TITLE-ENRICH (always on; opt-out via --no-fetch-titles): fetch webpage
  // titles and persist the URL→title map back into the CSV source-of-truth.
  const { enrichTitles } = await import('./title.js');
  const merged = readCsv(path.join(dir, 'messages.csv'));
  await enrichTitles(merged, {
    enabled: !opts.noFetchTitles,
    concurrency: 8,
    timeoutMs: 5000,
    verbose: Boolean(opts.verbose),
  });
  await writeCsv(path.join(dir, 'messages.csv'), merged);

  // MEDIA-01/02: reconcile referenced media and copy matched files to
  // <dir>/media/. Never throws on unresolved — missing refs are reported and
  // rendered as placeholders (MEDIA-03 / MEDIA-04).
  const distinctMedia = [...new Set(messages.map((m) => m.media).filter(Boolean))];
  const mediaReport = await reconcileMedia(zipPath, dir, distinctMedia);

  // Single run ALWAYS emits all four formats (D-22). The render pipeline reads
  // the freshly merged CSV back from disk.
  await renderOutputs(dir, name, { inline: Boolean(opts.inline) });

  if (opts.verbose) {
    verboseReport(
      detection ?? { dayFirst: Boolean(opts.dayFirst), is12h: false },
      warnings,
      messages.length,
    );
  }

  // MEDIA-03 reporting: surface resolved/unresolved counts on stderr so the
  // JSON/MD/HTML artifacts stay clean (D-M7).
  if (opts.verbose || mediaReport.resolved.length + mediaReport.unresolved.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      pc.dim('[wa-backup] media:') +
        ` ${mediaReport.resolved.length} resolved` +
        `, ${mediaReport.unresolved.length} unresolved`,
    );
    for (const u of mediaReport.unresolved) {
      // eslint-disable-next-line no-console
      console.error(pc.yellow(`  unresolved: ${u}`));
    }
  }
  return added;
}
