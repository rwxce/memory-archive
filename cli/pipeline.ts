import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { parseWhatsAppZip } from '@/lib/importers/whatsapp';
import type { Detection } from '@/lib/importers/whatsapp';
import { renderHtml, renderJson, renderMarkdown } from '@/lib/exporters/legacy';
import { mergeCsv, readCsv, writeCsv } from './csv';
import { buildMediaMap, dataUriLoader, reconcileMedia } from './media';
import { openZip } from './zip';

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

/** Source of the browser viewer script, read next to the exporter sources. */
function viewerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    path.join(here, '..', 'lib', 'exporters', 'legacy', 'js', 'transcript.js'),
    'utf8',
  );
}

/**
 * Render the three synchronized outputs (JSON / Markdown / HTML) from the
 * messages.csv source-of-truth in `dir` (D-20/D-21/D-22). Re-reads the CSV
 * from disk so old backups can be re-rendered without the original ZIP.
 */
export async function renderOutputs(
  dir: string,
  chatName: string,
  opts: { inline?: boolean } = {},
): Promise<RenderResult> {
  const csvPath = path.join(dir, 'messages.csv');
  if (!existsSync(csvPath)) return {};
  const messages = readCsv(csvPath);
  const media = buildMediaMap(dir, messages);
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
    await renderHtml(messages, chatName, { ...renderOpts, viewerScript: viewerScript() }),
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

  // TITLE-ENRICH (always on; opt-out via --no-fetch-titles): fetch webpage
  // titles and persist the URL→title map back into the CSV source-of-truth.
  const { enrichTitles } = await import('./titles');
  const merged = readCsv(csvPath);
  await enrichTitles(merged, {
    enabled: !opts.noFetchTitles,
    concurrency: 8,
    timeoutMs: 5000,
    verbose: Boolean(opts.verbose),
  });
  await writeCsv(csvPath, merged);

  // MEDIA-01/02: reconcile referenced media and copy matched files to
  // <dir>/media/. Never throws on unresolved — missing refs are reported and
  // rendered as placeholders (MEDIA-03 / MEDIA-04).
  const distinctMedia = [...new Set(messages.map((m) => m.media).filter(Boolean))];
  const mediaReport = await reconcileMedia(zipPath, dir, distinctMedia);

  // Single run ALWAYS emits all four formats (D-22).
  await renderOutputs(dir, info.name, { inline: Boolean(opts.inline) });

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
