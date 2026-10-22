import { openAsBlob } from 'node:fs';
import * as path from 'node:path';
import { chatInfoFromEntryNames, readZipEntries } from '@/lib/importers/whatsapp';
import type { ChatInfo, ReadZipOptions } from '@/lib/importers/whatsapp';
import {
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
} from '@/lib/exporters/archive/format';

/**
 * Bounds for an untrusted export ZIP, the same numbers a backup restore applies. The CLI reads
 * the file the user gives it, but a ZIP from a shared drive or a forwarded message is still
 * untrusted: without these a tiny archive can declare (or inflate to) far more than the disk holds.
 */
export const CLI_ZIP_LIMITS = {
  maxEntries: MAX_ENTRIES,
  maxCentralDirectoryBytes: MAX_CENTRAL_DIRECTORY_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
} satisfies ReadZipOptions;

/** `CLI_ZIP_LIMITS` plus the transcript cap (it is parsed in memory); same value as the app's. */
export const CLI_CHAT_ZIP_LIMITS = { ...CLI_ZIP_LIMITS, maxChatBytes: 256 * 1024 * 1024 };

/**
 * Node adapter: expose a ZIP on disk as a `Blob` backed by the file. Reads
 * are lazy and ranged (`Blob.slice`), so the archive is never loaded whole.
 */
export function openZip(zipPath: string): Promise<Blob> {
  return openAsBlob(zipPath);
}

/** Slug + display name of the chat inside a ZIP on disk. */
export async function chatInfoFromZip(zipPath: string): Promise<ChatInfo> {
  const entries = await readZipEntries(await openZip(zipPath), CLI_ZIP_LIMITS);
  return chatInfoFromEntryNames(
    entries.map((e) => e.name),
    path.basename(zipPath),
  );
}
