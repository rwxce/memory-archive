/**
 * The part of export and restore that does not know how the database is reached. It imports no
 * SQLite code (only types), so the PWA's client bundle can use it: `archive-backup.ts` for the
 * worker path, `archive.ts` for a handle in this thread.
 */
import { DbError } from '../db/errors';
import { SCHEMA_VERSION } from '../db/migrations';
import type { DbClient } from '../db/client';
import type { BlobRow, DatabaseExport } from '../db/snapshot';
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
import type { ThumbStore } from '../storage/thumb-store';
import { withArchiveGuard, type ArchiveLock } from './archive-guard';

export { ARCHIVE_LOCK_NAME, webArchiveLock, withArchiveGuard } from './archive-guard';
export type { ArchiveLock } from './archive-guard';
export { ArchiveError };
export type { ArchiveErrorCode } from '../exporters/archive/format';
export type { RestoreResult };

/**
 * The database side of a backup, so one export/restore core serves both a library whose SQLite
 * handle is in this thread (tests, Node) and the PWA, where it lives in the database worker
 * and is reached through the client.
 */
export interface ArchiveDatabase {
  /** Schema version, database bytes and media list, from one moment. */
  snapshot(): Promise<DatabaseExport>;
  isEmpty(): Promise<boolean>;
  /** All or nothing; `blobs` must equal the snapshot's own media list. */
  load(database: Uint8Array, blobs: BlobRow[]): Promise<void>;
}


/** The worker's errors in the archive's terms: the same `ArchiveError` codes either way. */
function archiveErrorOf(error: unknown): unknown {
  if (!(error instanceof DbError)) return error;
  if (error.code === 'constraint') return new ArchiveError('target-not-empty', 'this device already has an archive; restore only works on an empty one', { cause: error });
  if (error.code === 'newer-schema') return new ArchiveError('newer-schema', error.message, { cause: error });
  if (error.code === 'unavailable' || error.code === 'closed') return new ArchiveError('storage', 'the library is not available', { cause: error });
  return error;
}

export const clientDatabase = (client: Pick<DbClient, 'call'>): ArchiveDatabase => {
  const call = async <T>(work: Promise<T>): Promise<T> => work.catch((error: unknown) => Promise.reject(archiveErrorOf(error)));
  return {
    snapshot: () => call(client.call('exportDatabase')),
    isEmpty: () => call(client.call('isLibraryEmpty')),
    load: async (database, blobs) => {
      await call(client.call('restoreDatabase', { database, blobs }));
    },
  };
};

/** Where a backup or restore is. `media` counts files; `finishing` is the last step (the database). */
export type ArchiveProgress =
  | { phase: 'preparing' }
  | { phase: 'media'; done: number; total: number }
  | { phase: 'finishing' };

export interface ExportArchiveResult {
  blob: Blob;
  /** `memory-archive-YYYY-MM-DD.zip` */
  fileName: string;
  blobCount: number;
}

export interface ExportArchiveOptions {
  appVersion: string;
  now?: Date;
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ArchiveProgress) => void;
}

export interface RestoreArchiveOptions {
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ArchiveProgress) => void;
}

/** What an export or restore needs, whichever way the database is reached. */
export interface ArchiveParts {
  database: ArchiveDatabase;
  blobStore: BlobStore;
  thumbStore?: ThumbStore;
  lock?: ArchiveLock;
}

const exclusive = <T>(library: Pick<ArchiveParts, 'blobStore' | 'lock'>, work: () => Promise<T>) =>
  withArchiveGuard(library.blobStore, work, library.lock);
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


export async function exportParts(library: ArchiveParts, options: ExportArchiveOptions): Promise<ExportArchiveResult> {
  return exclusive(library, async () => {
    const now = options.now ?? new Date();
    options.onProgress?.({ phase: 'preparing' });
    // Schema version, database bytes and media list come from ONE moment (a single synchronous
    // read in the worker, which serializes requests); slow checks come after.
    const { schemaVersion, database, blobs } = await library.database.snapshot();
    assertRestorable(blobs, database.length, { ...DEFAULT_LIMITS, ...options.limits });
    for (const blob of blobs) {
      if ((await library.blobStore.size(blob.sha256)) !== blob.size) {
        throw new ArchiveError('blob-missing', 'a media file referenced by the library is missing or has the wrong size');
      }
    }
    const zip = await writeArchive({
      app: { name: APP_NAME, version: options.appVersion },
      createdAt: now,
      schemaVersion,
      database,
      blobs,
      openBlob: (sha256) => library.blobStore.open(sha256),
      onProgress: (done, total) => options.onProgress?.({ phase: 'media', done, total }),
    });
    options.onProgress?.({ phase: 'finishing' });
    return { blob: zip, fileName: archiveFileName(now), blobCount: blobs.length };
  });
}

export async function restoreParts(library: ArchiveParts, zip: Blob, options: RestoreArchiveOptions): Promise<RestoreResult> {
  return exclusive(library, async () => {
    options.onProgress?.({ phase: 'preparing' });
    if (!(await library.database.isEmpty())) {
      throw new ArchiveError('target-not-empty', 'this device already has an archive; restore only works on an empty one');
    }
    // The busy guard (`withArchiveGuard`, shared with import, undo and the orphan sweep) is the
    // ONLY protection against a concurrent writer here: without it this sweep could delete the
    // blobs of an import that has written them but not yet committed.
    // No row means no media is referenced: whatever the store holds is left over
    // from an interrupted import or restore. Sweep it so a retry can succeed.
    for (const sha256 of await library.blobStore.list()) {
      try {
        await library.blobStore.delete(sha256);
      } catch (cause) {
        throw new ArchiveError('storage', 'could not clear leftover media files from an interrupted restore', { cause });
      }
    }
    // Thumbnails are derived from blobs: a restored library starts with an empty cache.
    await library.thumbStore?.clear().catch(() => undefined);
    return restoreArchive(
      zip,
      {
        blobs: library.blobStore,
        supportedSchemaVersion: SCHEMA_VERSION,
        applyDatabase: async (database, blobs) => {
          options.onProgress?.({ phase: 'finishing' });
          await library.database.load(database, blobs);
        },
        onProgress: (done, total) => options.onProgress?.({ phase: 'media', done, total }),
      },
      { limits: options.limits },
    );
  });
}

