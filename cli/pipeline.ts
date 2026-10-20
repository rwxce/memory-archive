import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import pc from 'picocolors';
import { parseWhatsAppZip } from '@/lib/importers/whatsapp';
import type { Detection } from '@/lib/importers/whatsapp';
import { findAuthor, renderHtml, renderJson, renderMarkdown } from '@/lib/exporters/legacy';
import { mergeCsv, readCsv, writeCsv } from './csv';
import { buildMediaMap, dataUriLoader, reconcileMedia } from './media';
import type { FetchGuardOptions } from './titles';
import { openZip } from './zip';

export interface RunOptions {
  out?: string;
  dayFirst?: boolean;
  monthFirst?: boolean;
  verbose?: boolean;
  /** Embed resolved media as base64 `data:` URIs into a single HTML file. */
  inline?: boolean;
  /**
   * Fetch webpage titles for links (opt-in network access; default off).
   * Titles stored by earlier runs are kept either way.
   */
  fetchTitles?: boolean;
  /** Tests / embedding: DNS resolver and private-host policy for title fetches. */
  titleGuard?: FetchGuardOptions;
  /** Who owns the export (outgoing side). Falls back to the most frequent author. */
  me?: string;
}

export interface RenderOutputOptions {
  inline?: boolean;
  me?: string;
}

/** D-07 — transparency report for the detected file format. */
export function verboseReport(
  detection: Detection,
  warnings: string[],
  count: number,
): void {
  const order = detection.dayFirst ? 'DAY/MM (dd/mm)' : 'MM/DAY (mm/dd)';
  console.error(
    pc.dim(`[memory-archive] format detection:`) +
      `\n  order : ${pc.cyan(order)}${detection.overridden ? pc.yellow(' (CLI override)') : ''}` +
      `\n  clock : ${pc.cyan(detection.is12h ? '12h (AM/PM)' : '24h')}` +
      (detection.example ? `\n  sample: ${pc.dim(detection.example)}` : ''),
  );
  if (warnings.length) {
    console.error(
      pc.yellow(`  warnings (${warnings.length}):`) +
        '\n    ' +
        warnings.slice(0, 10).join('\n    ') +
        (warnings.length > 10 ? `\n    … and ${warnings.length - 10} more` : ''),
    );
  }
  console.error(pc.dim(`  parsed: ${count} messages`));
}

export interface RenderResult {
  json?: string;
  md?: string;
  html?: string;
}

/**
 * Render the three synchronized outputs (JSON / Markdown / HTML) from the
 * messages.csv source-of-truth in `dir` (D-20/D-21/D-22). Re-reads the CSV
 * from disk so old backups can be re-rendered without the original ZIP.
 */
export async function renderOutputs(
  dir: string,
  chatName: string,
  opts: RenderOutputOptions = {},
): Promise<RenderResult> {
  const csvPath = path.join(dir, 'messages.csv');
  if (!existsSync(csvPath)) return {};
  const messages = readCsv(csvPath);
  const media = buildMediaMap(dir, messages);
  if (opts.me && !findAuthor(messages, opts.me)) {
    console.error(
      pc.yellow(`[memory-archive] --me "${opts.me}" matches no author; guessing the owner instead.`),
    );
  }
  const renderOpts = {
    media,
    inline: Boolean(opts.inline),
    loadDataUri: dataUriLoader(dir),
  };
  const result: RenderResult = {
    json: path.join(dir, 'messages.json'),
    md: path.join(dir, 'messages.md'),
    html: path.join(dir, 'messages.html'),
  };
  await fs.writeFile(result.json!, renderJson(messages, chatName, media), 'utf8');
  await fs.writeFile(result.md!, await renderMarkdown(messages, chatName, renderOpts), 'utf8');
  await fs.writeFile(
    result.html!,
    await renderHtml(messages, chatName, { ...renderOpts, me: opts.me }),
    'utf8',
  );
  return result;
}

/**
 * Orchestrate the full vertical path:
 *   ZIP → parse → CSV merge → titles → media → render
 * writes `${out}/<chat>/messages.*` and returns the number of NEW messages.
 */
export async function runParser(
  zipPath: string,
  opts: RunOptions = {},
): Promise<number> {
  const zip = await openZip(zipPath);
  const { info, messages, detection, warnings } = await parseWhatsAppZip(
    zip,
    path.basename(zipPath),
    { dayFirst: opts.dayFirst, monthFirst: opts.monthFirst },
  );
  const out = opts.out ?? 'output';
  const dir = path.join(out, info.slug);
  await fs.mkdir(dir, { recursive: true });

  // Incremental merge into the CSV source-of-truth (D-13/D-16/D-17):
  // re-runs dedupe against existing rows and keep the file sorted ascending.
  const csvPath = path.join(dir, 'messages.csv');
  const added = await mergeCsv(csvPath, messages);

  // TITLE-ENRICH (opt-in via --fetch-titles): fetch titles only for links that
  // have none yet and persist the URL→title map in the CSV source-of-truth.
  // Without the flag nothing is fetched and stored titles stay untouched.
  if (opts.fetchTitles) {
    const { enrichTitles } = await import('./titles');
    const merged = readCsv(csvPath);
    await enrichTitles(merged, {
      ...opts.titleGuard,
      enabled: true,
      concurrency: 8,
      timeoutMs: 5000,
      verbose: Boolean(opts.verbose),
    });
    await writeCsv(csvPath, merged);
  }

  // MEDIA-01/02: reconcile referenced media and copy matched files to
  // <dir>/media/. Never throws on unresolved — missing refs are reported and
  // rendered as placeholders (MEDIA-03 / MEDIA-04).
  const distinctMedia = [...new Set(messages.map((m) => m.media).filter(Boolean))];
  const mediaReport = await reconcileMedia(zipPath, dir, distinctMedia);

  // Single run ALWAYS emits all four formats (D-22).
  await renderOutputs(dir, info.name, { inline: Boolean(opts.inline), me: opts.me });

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
    console.error(
      pc.dim('[memory-archive] media:') +
        ` ${mediaReport.resolved.length} resolved` +
        `, ${mediaReport.unresolved.length} unresolved`,
    );
    for (const u of mediaReport.unresolved) {
      console.error(pc.yellow(`  unresolved: ${u}`));
    }
  }
  return added;
}
