import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { mergeMessages, parseCsv, serializeCsv } from '@/lib/exporters/legacy';
import type { Message } from '@/lib/importers/whatsapp';

/** Read `messages.csv` from disk. */
export function readCsv(csvPath: string): Message[] {
  return parseCsv(readFileSync(csvPath, 'utf8'));
}

/** Write header + rows (overwrite; UTF-8, no BOM — D-19). */
export function writeCsv(csvPath: string, messages: Message[]): Promise<void> {
  return writeFile(csvPath, serializeCsv(messages), 'utf8');
}

/**
 * Merge `incoming` into the CSV on disk (dedupe + stable sort, see
 * `mergeMessages`) and rewrite it. Returns the number of NEW rows.
 */
export async function mergeCsv(csvPath: string, incoming: Message[]): Promise<number> {
  const existing = existsSync(csvPath) ? readCsv(csvPath) : [];
  const { messages, added } = mergeMessages(existing, incoming);
  await writeCsv(csvPath, messages);
  return added;
}
