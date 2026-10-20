import { parseCsv, parseCsvRecords } from '../../exporters/legacy/csv';
import { LegacyFormatError } from './types';
import type { LegacyArchive } from './types';

const HEADER_5 = ['timestamp_iso', 'type', 'author', 'text', 'media'];

/**
 * Read `messages.csv`: the 6-column form (`…,media,url_titles`) and the older
 * 5-column form without link titles. Refuses files whose header is not one
 * of those, so an unrelated CSV is never imported as a chat.
 */
export function readLegacyCsv(text: string): LegacyArchive {
  const clean = text.replace(/^\ufeff/, '');
  // The header never contains quoted newlines: its first physical line is enough.
  const header = parseCsvRecords(clean.split('\n')[0].replace(/\r$/, '') + '\n')[0] ?? [];
  const ok =
    (header.length === 5 || (header.length === 6 && header[5] === 'url_titles')) &&
    HEADER_5.every((h, i) => header[i] === h);
  if (!ok) throw new LegacyFormatError('not a messages.csv (unexpected header)');
  return { messages: parseCsv(clean), schemaVersion: 0, format: 'csv' };
}
