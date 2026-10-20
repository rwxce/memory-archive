import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { matchMediaEntries, openZipEntry, readZipEntries } from '@/lib/importers/whatsapp';
import { buildMediaMap as buildMediaMapFromFiles } from '@/lib/exporters/legacy';
import type { MediaEntry, MediaFile } from '@/lib/exporters/legacy';
import type { Message } from '@/lib/importers/whatsapp';
import { openZip } from './zip';

export {
  INLINE_MAX_BYTES,
  isInlineable,
  mimeFromExt,
} from '@/lib/exporters/legacy';
export { normalizeMediaName } from '@/lib/importers/whatsapp';
export type { MediaEntry } from '@/lib/exporters/legacy';

export interface ReconcileResult {
  /** Distinct refs that matched an actual zip entry. */
  resolved: string[];
  /** Distinct refs with no matching entry. */
  unresolved: string[];
}

/**
 * Locate media referenced by `_chat.txt` and copy the matched zip entries into
 * `<dir>/media/`, streaming each entry from the archive (the whole archive is
 * never buffered). Never throws on unresolved refs; they are reported.
 */
export async function reconcileMedia(
  zipPath: string,
  dir: string,
  refs: string[],
): Promise<ReconcileResult> {
  const mediaDir = path.join(dir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });

  const zip = await openZip(zipPath);
  const entries = await readZipEntries(zip);
  const { matches, unresolved } = matchMediaEntries(entries, refs);

  const resolved: string[] = [];
  for (const { ref, entry, fileName } of matches) {
    const source = Readable.fromWeb(openZipEntry(zip, entry) as NodeWebReadableStream<Uint8Array>);
    await pipeline(source, fs.createWriteStream(path.join(mediaDir, fileName)));
    resolved.push(ref);
  }
  return { resolved, unresolved };
}

/** List the files in `<dir>/media/` (empty when the folder is missing). */
export function listMediaFiles(dir: string): MediaFile[] {
  const mediaDir = path.join(dir, 'media');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: MediaFile[] = [];
  for (const e of entries) {
    if (e.isDirectory()) continue;
    try {
      files.push({ name: e.name, size: fs.statSync(path.join(mediaDir, e.name)).size });
    } catch {
      // vanished between readdir and stat: treat as missing
    }
  }
  return files;
}

/** Disk-resident media map for an output folder (D-M5). */
export function buildMediaMap(dir: string, messages: Message[]): Map<string, MediaEntry> {
  return buildMediaMapFromFiles(listMediaFiles(dir), messages);
}

/** `data:` URI loader for `--inline`, reading from the output folder. */
export function dataUriLoader(dir: string): (entry: MediaEntry) => Promise<string> {
  return async (entry) => {
    const bytes = await readFile(path.join(dir, entry.relPath));
    return `data:${entry.mime};base64,${bytes.toString('base64')}`;
  };
}
