import { SCHEMA_VERSION, readUserVersion } from '../db/migrations';
import { isLibraryEmpty, listBlobs, loadSnapshot, serializeDb } from '../db/snapshot';
import type { SqlDb } from '../db/sql';
import { restoreArchive, type RestoreResult } from '../exporters/archive/read';
import {
  APP_NAME,
  ArchiveError,
  DB_PATH,
  DEFAULT_LIMITS,
  MANIFEST_PATH,
  archiveFileName,
  blobPath,
  type ArchiveLimits,
} from '../exporters/archive/format';
import { writeArchive } from '../exporters/archive/write';
import type { BlobStore } from '../storage/blob-store';

export interface ArchiveLibrary {
  db: SqlDb;
  blobStore: BlobStore;
}

export interface ExportArchiveResult {
  blob: Blob;
  /** `memory-archive-YYYY-MM-DD.zip` */
  fileName: string;
  blobCount: number;
}

/**
 * Libraries with an export or restore in flight (in this thread). A second one
 * on the same library is refused with `busy`: two restores would otherwise
 * interleave their blob writes and cleanups. The flag is set before the first
 * `await`, released in `finally`.
 */
const running = new WeakSet<object>();

async function exclusive<T>(library: ArchiveLibrary, work: () => Promise<T>): Promise<T> {
  if (running.has(library.db)) throw new ArchiveError('busy', 'another backup or restore is already running');
  running.add(library.db);
  try {
    return await work();
  } finally {
    running.delete(library.db);
  }
}

/**
 * An export must never succeed when restore would refuse it: the same limits
 * restore enforces are checked here, from the known sizes, before any bytes are
 * written. The manifest itself (small JSON) is not counted in the total.
 */
function assertRestorable(blobs: readonly { size: number }[], databaseBytes: number, limits: ArchiveLimits): void {
  const tooBig = (what: string) => new ArchiveError('limit-exceeded', `the library is too large to back up in one archive (${what})`);
  const entries = blobs.length + 2; // manifest + database + blobs
  if (entries > limits.maxEntries) throw tooBig('too many files');
  if (databaseBytes > limits.maxDatabaseBytes) throw tooBig('database');
  let total = databaseBytes;
  for (const blob of blobs) {
    if (blob.size > limits.maxEntryBytes) throw tooBig('a media file');
    total += blob.size;
  }
  if (total > limits.maxTotalBytes) throw tooBig('total size');
  const directory = 46 * entries + MANIFEST_PATH.length + DB_PATH.length + blobs.length * blobPath('0'.repeat(64)).length;
  if (directory > limits.maxCentralDirectoryBytes) throw tooBig('too many files');
}

/**
 * Backs up the whole library (database + media) as one archive ZIP. Fails
 * without producing a file when a media file is missing or damaged.
 */
export async function exportArchive(
  library: ArchiveLibrary,
  options: { appVersion: string; now?: Date; limits?: Partial<ArchiveLimits> },
): Promise<ExportArchiveResult> {
  return exclusive(library, () => exportNow(library, options));
}

async function exportNow(
  library: ArchiveLibrary,
  options: { appVersion: string; now?: Date; limits?: Partial<ArchiveLimits> },
): Promise<ExportArchiveResult> {
  const now = options.now ?? new Date();
  // The media list, schema version and database bytes are read back to back,
  // synchronously: they describe the same moment (the worker serializes queries
  // between awaits, so nothing can write in between). Slow checks come after.
  const blobs = listBlobs(library.db);
  const schemaVersion = readUserVersion(library.db);
  const database = serializeDb(library.db);
  assertRestorable(blobs, database.length, { ...DEFAULT_LIMITS, ...options.limits });
  for (const blob of blobs) {
    if ((await library.blobStore.size(blob.sha256)) !== blob.size) {
      throw new ArchiveError('blob-missing', 'a media file referenced by the library is missing or has the wrong size');
    }
  }
  const blob = await writeArchive({
    app: { name: APP_NAME, version: options.appVersion },
    createdAt: now,
    schemaVersion,
    database,
    blobs,
    openBlob: (sha256) => library.blobStore.open(sha256),
  });
  return { blob, fileName: archiveFileName(now), blobCount: blobs.length };
}

/**
 * Restores an archive ZIP into a library that has no rows. Media files without a database row are leftovers and are swept first;
 * a library with rows is refused with `target-not-empty`: merging into an
 * existing library is a different operation. All or nothing.
 */
export async function restoreArchiveIntoEmptyLibrary(
  library: ArchiveLibrary,
  zip: Blob,
  options: { limits?: Partial<ArchiveLimits> } = {},
): Promise<RestoreResult> {
  return exclusive(library, () => restoreNow(library, zip, options));
}

async function restoreNow(library: ArchiveLibrary, zip: Blob, options: { limits?: Partial<ArchiveLimits> }): Promise<RestoreResult> {
  if (!isLibraryEmpty(library.db)) {
    throw new ArchiveError('target-not-empty', 'this device already has an archive; restore only works on an empty one');
  }
  // The busy guard (`exclusive`) is the ONLY protection against a concurrent writer here:
  // the future import use case must take the same guard, or this sweep could delete its blobs.
  // No row means no media is referenced: whatever the store holds is left over
  // from an interrupted import or restore. Sweep it so a retry can succeed.
  for (const sha256 of await library.blobStore.list()) {
    try {
      await library.blobStore.delete(sha256);
    } catch (cause) {
      throw new ArchiveError('storage', 'could not clear leftover media files from an interrupted restore', { cause });
    }
  }
  return restoreArchive(
    zip,
    {
      blobs: library.blobStore,
      supportedSchemaVersion: SCHEMA_VERSION,
      applyDatabase: async (database, blobs) => {
        await loadSnapshot(library.db, database, { expectBlobs: blobs });
      },
    },
    { limits: options.limits },
  );
}
