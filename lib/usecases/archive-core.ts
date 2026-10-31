/**
 * The part of export and restore that does not know how the database is reached. It imports no
 * SQLite code (only types), so the PWA's client bundle can use it: `archive-backup.ts` for the
 * worker path, `archive.ts` for a handle in this thread.
 */
import { sha256Hex } from '../domain/sha256';
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
  encryptedArchiveFileName,
  type ArchiveLimits,
} from '../exporters/archive/format';
import { assertCanEncrypt, encryptBackup, openBackupBlob, type CryptoProgress } from '../exporters/archive/encrypt';
import { verifyArchive } from '../exporters/archive/verify';
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
  /** Every check `load` runs on a snapshot, writing nothing: rejects when `load` would refuse it. */
  check(database: Uint8Array, blobs: BlobRow[]): Promise<void>;
  /**
   * All or nothing; `blobs` must equal the snapshot's own media list. `unchangedSince` (replace
   * only) is the SHA-256 of the library bytes that were backed up: a different library is refused
   * with `changed-during-replace`, atomically with the swap.
   */
  load(database: Uint8Array, blobs: BlobRow[], options?: { replace?: boolean; unchangedSince?: string }): Promise<void>;
}


/** The worker's errors in the archive's terms: the same `ArchiveError` codes either way. */
function archiveErrorOf(error: unknown): unknown {
  if (!(error instanceof DbError)) return error;
  if (error.code === 'constraint') return new ArchiveError('target-not-empty', 'this device already has an archive; restore only works on an empty one', { cause: error });
  if (error.code === 'changed') return new ArchiveError('changed-during-replace', 'the library changed after its safety backup was made; nothing was replaced', { cause: error });
  if (error.code === 'newer-schema') return new ArchiveError('newer-schema', error.message, { cause: error });
  if (error.code === 'unavailable' || error.code === 'closed') return new ArchiveError('storage', 'the library is not available', { cause: error });
  return error;
}

export const clientDatabase = (client: Pick<DbClient, 'call'>): ArchiveDatabase => {
  const call = async <T>(work: Promise<T>): Promise<T> => work.catch((error: unknown) => Promise.reject(archiveErrorOf(error)));
  return {
    snapshot: () => call(client.call('exportDatabase')),
    isEmpty: () => call(client.call('isLibraryEmpty')),
    check: async (database, blobs) => {
      await call(client.call('checkDatabase', { database, blobs }));
    },
    load: async (database, blobs, options) => {
      await call(client.call('restoreDatabase', { database, blobs, replace: options?.replace, unchangedSince: options?.unchangedSince }));
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
  /** `memory-archive-YYYY-MM-DD.zip`, or `.mabackup` when encrypted. */
  fileName: string;
  blobCount: number;
  /**
   * Whether the file is password-encrypted. When `false` it is a plain ZIP holding every message
   * and photo readably: the UI marks it as private.
   */
  encrypted: boolean;
}

export interface ExportArchiveOptions {
  appVersion: string;
  now?: Date;
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ArchiveProgress) => void;
  /** Encrypts the backup with this password (see `docs/formats/encrypted-backup.md`). `undefined` = plain ZIP; an empty string is refused (`password-required`). */
  password?: string;
  /** Progress of the encryption step, which runs after `finishing`. */
  onCryptoProgress?: (progress: CryptoProgress) => void;
  /** Stops the encryption between chunks; rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface RestoreArchiveOptions {
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ArchiveProgress) => void;
  /** Needed when the file is encrypted (`password-required` / `wrong-password`); ignored for a plain ZIP. */
  password?: string;
  /** Progress of the decryption step, which runs first. */
  onCryptoProgress?: (progress: CryptoProgress) => void;
  signal?: AbortSignal;
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


export const exportParts = (library: ArchiveParts, options: ExportArchiveOptions): Promise<ExportArchiveResult> =>
  exclusive(library, () => exportUnguarded(library, options));

/** The export, for a caller that already holds the archive guard. */
async function exportUnguarded(
  library: ArchiveParts,
  options: ExportArchiveOptions,
  /** Sees the database bytes the archive is built from (replace remembers their digest). */
  observe?: (database: Uint8Array) => void,
): Promise<ExportArchiveResult> {
  const now = options.now ?? new Date();
  // Fail fast, before the ZIP is built: an empty password or no WebCrypto cannot produce a backup.
  if (options.password !== undefined) assertCanEncrypt(options.password);
  options.onProgress?.({ phase: 'preparing' });
  // Schema version, database bytes and media list come from ONE moment (a single synchronous
  // read in the worker, which serializes requests); slow checks come after.
  const { schemaVersion, database, blobs } = await library.database.snapshot();
  observe?.(database);
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
  if (options.password === undefined) return { blob: zip, fileName: archiveFileName(now), blobCount: blobs.length, encrypted: false };
  const sealed = await encryptBackup(zip, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
  return { blob: sealed, fileName: encryptedArchiveFileName(now), blobCount: blobs.length, encrypted: true };
}

export const restoreParts = (library: ArchiveParts, zip: Blob, options: RestoreArchiveOptions): Promise<RestoreResult> =>
  exclusive(library, () => restoreUnguarded(library, zip, options));

async function restoreUnguarded(library: ArchiveParts, file: Blob, options: RestoreArchiveOptions): Promise<RestoreResult> {
  options.onProgress?.({ phase: 'preparing' });
  if (!(await library.database.isEmpty())) {
    throw new ArchiveError('target-not-empty', 'this device already has an archive; restore only works on an empty one');
  }
  // Before anything is swept or written: a wrong password changes nothing.
  const zip = await openBackupBlob(file, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
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
}

/** Where a replace is: the safety backup of the current library, then the chosen backup going in. */
export type ReplaceProgress = { stage: 'safety-backup' | 'restoring'; progress: ArchiveProgress };

export interface ReplaceLibraryOptions {
  appVersion: string;
  now?: Date;
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ReplaceProgress) => void;
  /** Checked between steps and per media file; rejects with the signal's reason. Ignored once the swap has committed. */
  signal?: AbortSignal;
  /**
   * Hands the safety backup of the CURRENT library to the person (a download). Called only when the
   * library has data, and the replace does not go on until it resolves. If it rejects, nothing is changed
   * and the replace fails with `safety-backup-failed`.
   */
  deliverSafetyBackup: (blob: Blob, fileName: string) => Promise<void>;
  /** Needed when the chosen backup is encrypted. The safety backup of the current library is NOT encrypted (`encrypted: false`). */
  password?: string;
  onCryptoProgress?: (progress: CryptoProgress) => void;
}

export interface ReplaceLibraryResult extends RestoreResult {
  /** The file name handed to `deliverSafetyBackup`, or `undefined` when the library was empty (no safety backup made). */
  safetyBackupFileName?: string;
  /**
   * Old media files that could not be deleted after the swap. Harmless: no row points at them. The
   * next library open (`sweepLeftovers`) or the next replace removes them.
   */
  leftoverBlobs: number;
}

/** Failures of the swap after which the old library is certainly intact (the transaction rolled back or never started). */
const rolledBack = (error: unknown): boolean =>
  error instanceof ArchiveError
    ? error.code === 'changed-during-replace' || error.code === 'newer-schema' || error.code === 'invalid-database'
    : error instanceof DbError && (error.code === 'invalid' || error.code === 'constraint' || error.code === 'newer-schema' || error.code === 'changed');

export async function replaceParts(library: ArchiveParts, file: Blob, options: ReplaceLibraryOptions): Promise<ReplaceLibraryResult> {
  const aborted = () => {
    if (options.signal?.aborted) throw options.signal.reason;
  };
  const zip = await openBackupBlob(file, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
  // 1. The chosen backup must verify completely before anything of the current library is touched.
  const verification = await verifyArchive(zip, { supportedSchemaVersion: SCHEMA_VERSION, limits: options.limits, signal: options.signal });
  if (!verification.ok) {
    throw new ArchiveError(verification.refusal ?? 'integrity', 'the chosen backup did not pass verification; nothing was changed');
  }
  aborted();
  return exclusive(library, async () => {
    let safetyBackupFileName: string | undefined;
    // SHA-256 of the library bytes the safety backup (or the empty check) saw: the swap only goes
    // ahead if the library is still exactly that. Notes, favorites and profile edits do not take
    // the archive guard, so this is what stops them being lost between the two.
    let libraryDigest: string | undefined;
    const restoreProgress = (progress: ArchiveProgress) => options.onProgress?.({ stage: 'restoring', progress });
    restoreProgress({ phase: 'preparing' });
    // `true` while the swap may have been committed: then the media it brought must stay.
    let swapMayHaveHappened = false;
    // An abort noticed at the swap must surface as the signal's reason, not as a database failure.
    let abortedAtSwap = false;
    const kept = new Set<string>();
    let result: RestoreResult;
    try {
      result = await restoreArchive(
        zip,
        {
          blobs: library.blobStore,
          supportedSchemaVersion: SCHEMA_VERSION,
          // 2. With the database bytes in hand and NOTHING written yet: refuse a backup whose
          // database is bad (valid hashes do not make it loadable), then make the safety backup.
          // Nothing proceeds until the person has it.
          beforeMedia: async (database, blobs) => {
            try {
              await library.database.check(database, blobs);
            } catch (cause) {
              throw cause instanceof ArchiveError ? cause : new ArchiveError('invalid-database', 'the chosen backup\'s database could not be loaded; nothing was changed', { cause });
            }
            aborted();
            if (await library.database.isEmpty()) {
              libraryDigest = sha256Hex((await library.database.snapshot()).database);
              return;
            }
            let safety: ExportArchiveResult;
            try {
              safety = await exportUnguarded(
                library,
                {
                  appVersion: options.appVersion,
                  now: options.now,
                  limits: options.limits,
                  onProgress: (progress) => options.onProgress?.({ stage: 'safety-backup', progress }),
                },
                (bytes) => {
                  libraryDigest = sha256Hex(bytes);
                },
              );
            } catch (cause) {
              throw new ArchiveError('safety-backup-failed', 'could not build a safety backup of the current archive; nothing was changed', { cause });
            }
            aborted();
            try {
              await options.deliverSafetyBackup(safety.blob, safety.fileName);
            } catch (cause) {
              throw new ArchiveError('safety-backup-failed', 'the safety backup was not saved; nothing was changed', { cause });
            }
            safetyBackupFileName = safety.fileName;
            aborted();
          },
          // 3. Swap. The new media go into the content-addressed store ALONGSIDE the old (a hash
          // both have is stored once); the database is then replaced in ONE transaction.
          applyDatabase: async (database, blobs) => {
            if (options.signal?.aborted) {
              abortedAtSwap = true;
              throw options.signal.reason;
            }
            restoreProgress({ phase: 'finishing' });
            swapMayHaveHappened = true;
            try {
              await library.database.load(database, blobs, { replace: true, unchangedSince: libraryDigest });
            } catch (error) {
              if (rolledBack(error)) swapMayHaveHappened = false;
              throw error;
            }
            for (const blob of blobs) kept.add(blob.sha256);
          },
          // A failure before the commit deletes only the files this replace added and leaves the old
          // library intact. If the swap's outcome is unknown (the worker died before answering) the new
          // database may reference them: keep them and report them as leftovers.
          cleanupOnFailure: () => !swapMayHaveHappened,
          onProgress: (done, total) => {
            aborted();
            restoreProgress({ phase: 'media', done, total });
          },
        },
        { limits: options.limits },
      );
    } catch (error) {
      if (abortedAtSwap) throw options.signal!.reason;
      throw error;
    }

    // 4. Committed. Drop the old library's files nothing references any more, and the thumbnails
    // derived from them. Failures here only leave harmless orphans.
    let leftoverBlobs = 0;
    try {
      for (const sha256 of await library.blobStore.list()) {
        if (kept.has(sha256)) continue;
        if (!(await library.blobStore.delete(sha256).then(() => true, () => false))) leftoverBlobs++;
      }
    } catch {
      leftoverBlobs++;
    }
    await library.thumbStore?.clear().catch(() => undefined);
    return { ...result, safetyBackupFileName, leftoverBlobs };
  });
}
