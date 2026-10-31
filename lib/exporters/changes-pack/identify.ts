import { ARCHIVE_FORMAT_NAME } from '../../domain/archive';
import { CHANGES_PACK_FORMAT_NAME } from '../../domain/changes-pack';
import { ZipLimitError, readZipEntries } from '../../importers/whatsapp/zip';
import { ArchiveError, DEFAULT_LIMITS, MANIFEST_PATH, type ArchiveLimits } from '../archive/format';
import { collect, guardedStream } from '../archive/read';

/** What a plain ZIP handed to the app is, by the `format` of its manifest. */
export type ArchiveFileKind = 'backup' | 'changes-pack' | 'unknown';

/**
 * Tells a full backup from a changes pack (and from anything else) without importing it: reads the
 * central directory and only the manifest, and looks at its `format` name. The two packages share a
 * container, so the file name or extension proves nothing, and an encrypted file only shows what it
 * is after it is decrypted (`openBackupBlob`). Validates nothing else: the real readers do.
 * Throws `not-an-archive` / `limit-exceeded` for a ZIP that cannot be read.
 */
export async function identifyArchiveFile(zip: Blob, limits: Partial<ArchiveLimits> = {}): Promise<ArchiveFileKind> {
  const l = { ...DEFAULT_LIMITS, ...limits };
  let entries;
  try {
    entries = await readZipEntries(zip, { maxEntries: l.maxEntries, maxCentralDirectoryBytes: l.maxCentralDirectoryBytes });
  } catch (cause) {
    if (cause instanceof ZipLimitError) throw new ArchiveError('limit-exceeded', 'the archive directory is larger than allowed', { cause });
    throw new ArchiveError('not-an-archive', 'this file is not a readable ZIP archive', { cause });
  }
  const entry = entries.find((e) => e.name === MANIFEST_PATH);
  if (!entry) return 'unknown';
  if (entry.uncompressedSize > l.maxManifestBytes) throw new ArchiveError('limit-exceeded', 'an archive entry is larger than allowed');
  const failure: { error?: ArchiveError } = {};
  const bytes = await collect(guardedStream(zip, entry, { size: entry.uncompressedSize, maxBytes: l.maxManifestBytes }, failure), failure);
  let format: unknown;
  try {
    format = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { format?: unknown } | null)?.format;
  } catch {
    return 'unknown';
  }
  if (format === ARCHIVE_FORMAT_NAME) return 'backup';
  if (format === CHANGES_PACK_FORMAT_NAME) return 'changes-pack';
  return 'unknown';
}
