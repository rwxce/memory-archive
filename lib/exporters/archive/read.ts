import { createSha256 } from '../../domain/sha256';
import { ZipLimitError, openZipEntry, readZipEntries, type ZipEntry } from '../../importers/whatsapp/zip';
import {
  ArchiveError,
  COMPRESSION_RATIO_FLOOR_BYTES,
  DB_PATH,
  DEFAULT_LIMITS,
  MANIFEST_PATH,
  parseManifest,
  validateEntryPath,
  type ArchiveLimits,
  type ArchiveManifest,
  type ManifestEntry,
} from './format';
import type { ArchiveBlobRef } from './write';

/** The slice of `BlobStore` restore needs (the exporter layer does not import storage). */
export interface RestoreBlobSink {
  put(source: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }>;
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<boolean>;
}

export interface RestoreHooks {
  blobs: RestoreBlobSink;
  /** Newest database schema this app understands. */
  supportedSchemaVersion: number;
  /**
   * Loads the verified database snapshot, atomically (all or nothing). `blobs`
   * is the exact list of media the archive carries, for cross-checking.
   */
  applyDatabase(database: Uint8Array, blobs: ArchiveBlobRef[]): Promise<void>;
  /** Called before the first media file (done 0) and after each one, with the total to store. */
  onProgress?(done: number, total: number): void;
}

export interface RestoreOptions {
  limits?: Partial<ArchiveLimits>;
}

export interface RestoreResult {
  manifest: ArchiveManifest;
  blobCount: number;
}

interface Expectation {
  /** Exact uncompressed size the entry must have. */
  size: number;
  /** Hard ceiling, checked while streaming. */
  maxBytes: number;
  sha256?: string;
}

/**
 * Streams one entry's inflated bytes while counting the ACTUAL bytes (declared
 * sizes in a ZIP are attacker-controlled): aborts as soon as the entry exceeds
 * its cap or the size it was supposed to have (the directory check already
 * refused a deflated entry whose declared size is a suspicious multiple of its
 * compressed size, so counting real bytes against that size is the ratio guard),
 * and verifies size and SHA-256 at the end. Errors are `ArchiveError`s, also
 * recorded in `failure` because a consumer may wrap them.
 */
function guardedStream(
  zip: Blob,
  entry: ZipEntry,
  expect: Expectation,
  failure: { error?: ArchiveError },
): ReadableStream<Uint8Array> {
  const reader = openZipEntry(zip, entry).getReader();
  const hasher = createSha256();
  let actual = 0;
  const abort = (error: ArchiveError, controller: ReadableStreamDefaultController<Uint8Array>) => {
    failure.error ??= error;
    reader.cancel().catch(() => undefined);
    controller.error(error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (cause) {
        if (cause instanceof ZipLimitError) {
          return abort(new ArchiveError('limit-exceeded', 'an archive entry is larger than allowed', { cause }), controller);
        }
        return abort(new ArchiveError('not-an-archive', 'an archive entry is corrupt', { cause }), controller);
      }
      if (result.done) {
        if (actual !== expect.size) return abort(new ArchiveError('integrity', 'an archive entry has the wrong size'), controller);
        if (expect.sha256 !== undefined && hasher.digestHex() !== expect.sha256) {
          return abort(new ArchiveError('integrity', 'an archive entry does not match its recorded hash'), controller);
        }
        return controller.close();
      }
      actual += result.value.length;
      if (actual > expect.maxBytes || actual > expect.size) {
        return abort(new ArchiveError('limit-exceeded', 'an archive entry is larger than allowed'), controller);
      }
      hasher.update(result.value);
      controller.enqueue(result.value);
    },
    cancel: () => reader.cancel(),
  });
}

async function collect(stream: ReadableStream<Uint8Array>, failure: { error?: ArchiveError }): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } catch (error) {
    throw failure.error ?? error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface OpenedArchive {
  manifest: ArchiveManifest;
  /** Every ZIP entry by name (the manifest included). */
  byName: Map<string, ZipEntry>;
  /** The manifest's entries by path. */
  listed: Map<string, ManifestEntry>;
}

/**
 * Everything restore checks before it reads an entry's content: central directory and structural
 * limits, safe and unique paths, per-entry caps and the zip-bomb ratio, the strictly validated
 * manifest, and that ZIP entries and manifest describe exactly the same set with the same sizes.
 * Shared with `verifyArchive`. Throws `ArchiveError`; writes nothing.
 */
export async function openArchive(
  zip: Blob,
  supportedSchemaVersion: number,
  limits: ArchiveLimits,
  failure: { error?: ArchiveError } = {},
): Promise<OpenedArchive> {
  // 1. Central directory and structural limits, before any entry is read.
  let entries: ZipEntry[];
  try {
    entries = await readZipEntries(zip, {
      maxEntries: limits.maxEntries,
      maxCentralDirectoryBytes: limits.maxCentralDirectoryBytes,
    });
  } catch (cause) {
    if (cause instanceof ZipLimitError) throw new ArchiveError('limit-exceeded', 'the archive directory is larger than allowed', { cause });
    throw new ArchiveError('not-an-archive', 'this file is not a readable ZIP archive', { cause });
  }
  if (entries.length > limits.maxEntries) throw new ArchiveError('limit-exceeded', 'the archive has too many entries');
  const byName = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  for (const entry of entries) {
    validateEntryPath(entry.name);
    if (byName.has(entry.name)) throw new ArchiveError('duplicate-entry', 'the archive contains the same path twice');
    byName.set(entry.name, entry);
    const cap =
      entry.name === MANIFEST_PATH ? limits.maxManifestBytes : entry.name === DB_PATH ? limits.maxDatabaseBytes : limits.maxEntryBytes;
    if (entry.uncompressedSize > cap) throw new ArchiveError('limit-exceeded', 'an archive entry is larger than allowed');
    if (entry.compression === 0 && entry.compressedSize !== entry.uncompressedSize) {
      throw new ArchiveError('not-an-archive', 'an archive entry is corrupt');
    }
    if (
      entry.compression !== 0 &&
      entry.uncompressedSize > Math.max(entry.compressedSize, COMPRESSION_RATIO_FLOOR_BYTES) * limits.maxCompressionRatio
    ) {
      throw new ArchiveError('limit-exceeded', 'an archive entry expands suspiciously (zip bomb)');
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError('limit-exceeded', 'the archive is too large');
  }

  // 2. Manifest, size-capped and strictly validated.
  const manifestEntry = byName.get(MANIFEST_PATH);
  if (!manifestEntry) throw new ArchiveError('invalid-manifest', 'the archive has no manifest');
  const manifestBytes = await collect(
    guardedStream(zip, manifestEntry, { size: manifestEntry.uncompressedSize, maxBytes: limits.maxManifestBytes }, failure),
    failure,
  );
  const manifest = parseManifest(manifestBytes, supportedSchemaVersion, limits);

  // 3. Entry list and manifest must describe exactly the same set.
  const listed = new Map(manifest.entries.map((e) => [e.path, e]));
  for (const name of byName.keys()) {
    if (name !== MANIFEST_PATH && !listed.has(name)) throw new ArchiveError('entry-mismatch', 'the archive contains an entry the manifest does not list');
  }
  for (const item of manifest.entries) {
    const entry = byName.get(item.path);
    if (!entry) throw new ArchiveError('entry-mismatch', 'the manifest lists an entry the archive does not contain');
    if (entry.uncompressedSize !== item.size) throw new ArchiveError('integrity', 'an archive entry does not have the size the manifest records');
  }
  return { manifest, byName, listed };
}

/**
 * Restores an archive ZIP into an EMPTY library (the caller checks emptiness).
 * The archive is untrusted: nothing is written until the central directory,
 * the manifest and the entry list have passed validation, every byte is
 * counted and hashed as it streams, and the database goes in last. On any
 * failure the blobs this restore stored are deleted and the database is
 * untouched, so the library is exactly as it was.
 *
 * One deliberate deviation from "database last": the database entry (small,
 * bounded by `maxEntryBytes`) is read and hash-verified before the blobs so a
 * tampered snapshot fails before any media is written; it is still applied last.
 */
export async function restoreArchive(zip: Blob, hooks: RestoreHooks, options: RestoreOptions = {}): Promise<RestoreResult> {
  const limits: ArchiveLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const failure: { error?: ArchiveError } = {};
  const { manifest, byName, listed } = await openArchive(zip, hooks.supportedSchemaVersion, limits, failure);

  const written: string[] = [];
  try {
    // 4. Database bytes, verified now, applied last.
    const dbItem = listed.get(DB_PATH)!;
    const database = await collect(
      guardedStream(zip, byName.get(DB_PATH)!, { size: dbItem.size, maxBytes: limits.maxDatabaseBytes, sha256: dbItem.sha256 }, failure),
      failure,
    );

    // 5. Blobs: streamed through the store, hash-verified on the way.
    const blobs: ArchiveBlobRef[] = [];
    const total = manifest.entries.length - 1;
    hooks.onProgress?.(0, total);
    for (const item of manifest.entries) {
      if (item.path === DB_PATH) continue;
      blobs.push({ sha256: item.sha256, size: item.size });
      const already = await hooks.blobs.has(item.sha256);
      const stream = guardedStream(zip, byName.get(item.path)!, { size: item.size, maxBytes: limits.maxEntryBytes, sha256: item.sha256 }, failure);
      let stored: { sha256: string; size: number };
      try {
        stored = await hooks.blobs.put(stream);
      } catch (cause) {
        throw failure.error ?? new ArchiveError('storage', 'could not store a media file', { cause });
      }
      if (!already) written.push(stored.sha256);
      if (stored.sha256 !== item.sha256 || stored.size !== item.size) {
        throw new ArchiveError('integrity', 'a stored media file does not match the manifest');
      }
      hooks.onProgress?.(blobs.length, total);
    }

    // 6. Database last.
    try {
      await hooks.applyDatabase(database, blobs);
    } catch (cause) {
      throw cause instanceof ArchiveError
        ? cause
        : new ArchiveError('invalid-database', 'the archive database could not be loaded', { cause });
    }
    return { manifest, blobCount: blobs.length };
  } catch (error) {
    // A blob that cannot be deleted now is an orphan (no database row points at
    // it): the next restore into the empty library sweeps it. Say so.
    let leftover = 0;
    for (const sha256 of written) {
      if (!(await hooks.blobs.delete(sha256).then(() => true, () => false))) leftover++;
    }
    if (leftover > 0 && error instanceof ArchiveError) error.leftoverBlobs = leftover;
    throw error;
  }
}
