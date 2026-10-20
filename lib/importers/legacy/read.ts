import { readLegacyCsv } from './csv';
import { readLegacyHtml } from './html';
import { readLegacyJson } from './json';
import { LegacyFormatError } from './types';
import type { LegacyArchive } from './types';

/**
 * Why Markdown is refused: `messages.md` is a lossy rendering. It keeps only
 * HH:mm (no seconds), drops the author of system/deleted/omitted lines,
 * replaces link URLs by `[title](url)` and HTML-escapes text, and writes day
 * headers as localized long dates. Re-importing it would silently change
 * timestamps and text, so duplicates could not be detected reliably.
 */
export const MARKDOWN_NOT_SUPPORTED =
  'messages.md is a lossy rendering (minutes only, escaped text, rewritten links) and cannot be ' +
  're-imported; use messages.json, messages.html or messages.csv from the same folder.';

/** Pick a reader from the file name, falling back to sniffing the content. */
export function readLegacyOutput(fileName: string, text: string): LegacyArchive {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'json') return readLegacyJson(text);
  if (ext === 'html' || ext === 'htm') return readLegacyHtml(text);
  if (ext === 'csv') return readLegacyCsv(text);
  if (ext === 'md' || ext === 'markdown') throw new LegacyFormatError(MARKDOWN_NOT_SUPPORTED);

  const head = text.replace(/^\ufeff/, '').trimStart();
  if (head.startsWith('{')) return readLegacyJson(text);
  if (/^<(!doctype|html)/i.test(head)) return readLegacyHtml(text);
  if (head.startsWith('timestamp_iso,')) return readLegacyCsv(text);
  throw new LegacyFormatError(`unrecognised file: ${fileName}`);
}
