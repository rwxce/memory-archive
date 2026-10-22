import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { ARCHIVE_FORMAT_NAME, ARCHIVE_FORMAT_VERSION } from '../../domain/archive';
import { createSha256, sha256Hex } from '../../domain/sha256';
import {
  ArchiveError,
  DB_PATH,
  MANIFEST_PATH,
  blobPath,
  isSha256Hex,
  type ArchiveManifest,
  type ManifestEntry,
} from './format';

export interface ArchiveBlobRef {
  sha256: string;
  size: number;
}

export interface ArchiveSource {
  app: { name: string; version: string };
  /** Instant recorded in the manifest and used as every entry's timestamp. */
  createdAt: Date;
  /** `PRAGMA user_version` of `database`. */
  schemaVersion: number;
  /** The SQLite file, already serialized. */
  database: Uint8Array;
  /** The `blobs` rows: hash and size are taken from here, never recomputed from names. */
  blobs: readonly ArchiveBlobRef[];
  /** The stored bytes of one blob, or `undefined` when absent. */
  openBlob(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Called after each media file has been written, with how many are done out of the total. */
  onProgress?(done: number, total: number): void;
}

/** Produced bytes are folded into a `Blob` (which the browser may keep outside the JS heap) this often. */
const FLUSH_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

/**
 * Writes the archive ZIP (format in `format.ts`) with fflate's streaming `Zip`.
 *
 * Not streamed to disk: the output is assembled as a `Blob` of the produced
 * chunks. Every ~16 MB the pending chunks are folded into a sub-`Blob`, so the
 * JS heap holds at most that much plus the database bytes while browsers can
 * keep the rest outside it; the input blobs are streamed one chunk at a time.
 * Writing straight to a file handle (File System Access) is the follow-up.
 *
 * Every blob is hashed again while it streams out; a blob whose bytes no
 * longer match its row (bit rot, truncation) aborts the export instead of
 * writing a backup that cannot be restored.
 */
export async function writeArchive(source: ArchiveSource): Promise<Blob> {
  const blobs = [...source.blobs].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  for (const blob of blobs) {
    if (!isSha256Hex(blob.sha256) || !Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new ArchiveError('blob-missing', 'a media reference is malformed');
    }
  }
  const entries: ManifestEntry[] = [
    { path: DB_PATH, size: source.database.length, sha256: sha256Hex(source.database) },
    ...blobs.map((b) => ({ path: blobPath(b.sha256), size: b.size, sha256: b.sha256 })),
  ];
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: source.createdAt.toISOString(),
    app: source.app,
    schemaVersion: source.schemaVersion,
    entries,
  };

  const folded: Blob[] = [];
  let parts: Uint8Array[] = [];
  let pending = 0;
  let failure: unknown;
  const zip = new Zip((error, chunk) => {
    if (error) {
      failure = error;
      return;
    }
    parts.push(chunk);
    pending += chunk.length;
    if (pending >= FLUSH_BYTES) {
      folded.push(new Blob(parts as BlobPart[]));
      parts = [];
      pending = 0;
    }
  });
  const check = () => {
    if (failure) throw new ArchiveError('storage', 'could not assemble the archive', { cause: failure });
  };

  const addSmall = (data: Uint8Array, file: ZipDeflate | ZipPassThrough) => {
    file.mtime = source.createdAt;
    zip.add(file);
    file.push(data, true);
    check();
  };

  addSmall(encoder.encode(JSON.stringify(manifest, null, 2)), new ZipDeflate(MANIFEST_PATH, { level: 6 }));
  addSmall(source.database, new ZipPassThrough(DB_PATH));

  try {
    let done = 0;
    for (const blob of blobs) {
      const stream = await source.openBlob(blob.sha256);
      if (!stream) throw new ArchiveError('blob-missing', 'a media file referenced by the library is missing');
      const file = new ZipPassThrough(blobPath(blob.sha256));
      file.mtime = source.createdAt;
      zip.add(file);
      const hasher = createSha256();
      let size = 0;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > blob.size) break;
          hasher.update(value);
          file.push(value, false);
          check();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (size !== blob.size || hasher.digestHex() !== blob.sha256) {
        throw new ArchiveError('integrity', 'a media file no longer matches its recorded hash; the library is damaged');
      }
      file.push(EMPTY, true);
      check();
      source.onProgress?.(++done, blobs.length);
    }
  } catch (error) {
    zip.terminate();
    throw error;
  }
  zip.end();
  check();
  return new Blob([...folded, ...(parts as BlobPart[])], { type: 'application/zip' });
}
