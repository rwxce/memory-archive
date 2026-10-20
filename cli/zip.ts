import { openAsBlob } from 'node:fs';
import * as path from 'node:path';
import { chatInfoFromEntryNames, readZipEntries } from '@/lib/importers/whatsapp';
import type { ChatInfo } from '@/lib/importers/whatsapp';

/**
 * Node adapter: expose a ZIP on disk as a `Blob` backed by the file. Reads
 * are lazy and ranged (`Blob.slice`), so the archive is never loaded whole.
 */
export function openZip(zipPath: string): Promise<Blob> {
  return openAsBlob(zipPath);
}

/** Slug + display name of the chat inside a ZIP on disk. */
export async function chatInfoFromZip(zipPath: string): Promise<ChatInfo> {
  const entries = await readZipEntries(await openZip(zipPath));
  return chatInfoFromEntryNames(
    entries.map((e) => e.name),
    path.basename(zipPath),
  );
}
