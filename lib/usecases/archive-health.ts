import { SCHEMA_VERSION } from '../db/migrations';
import type { DanglingReference } from '../db/queries';
import { verifyArchive, type BackupVerification } from '../exporters/archive/verify';
import type { ArchiveLimits } from '../exporters/archive/format';
import { readStorageStatus, type StorageStatus } from '../storage/quota';
import { withArchiveGuard } from './archive-guard';
import type { ProfileDeps } from './profiles';

export type { BackupProblem, BackupVerification } from '../exporters/archive/verify';
export type { StorageStatus };

/*
 * Health checks for the Backup and restore screen. All three are read-only: they never change the
 * library, the blob store or the file they are given. Results are typed data (kinds, counts, content
 * hashes, ids); they carry no file names, message text or author names, so the UI can show them as
 * it likes and nothing here can leak chat content into a message.
 */

/** Problems kept in a result; the counts always cover all of them. */
export const MAX_REPORTED_PROBLEMS = 100;
const PAGE = 500;

export type IntegrityProblem =
  /** A `blobs` row whose file is not in the blob store. */
  | { kind: 'missing-file'; sha256: string }
  /** The stored file has a different size from the row. */
  | { kind: 'wrong-size'; sha256: string; expected: number; actual: number }
  /** The stored bytes no longer hash to the file's name. */
  | { kind: 'hash-mismatch'; sha256: string }
  /** A message or profile photo points at a hash that has no `blobs` row. */
  | ({ kind: 'dangling-reference' } & DanglingReference);

export interface IntegrityProgress {
  /** Files looked at so far / files in the library. */
  done: number;
  total: number;
  /** Bytes of those files. */
  bytesDone: number;
  bytesTotal: number;
}

export interface LibraryIntegrity {
  /** No problem found. */
  ok: boolean;
  checkedFiles: number;
  checkedBytes: number;
  /** All problems found; `problems` holds the first `MAX_REPORTED_PROBLEMS`. */
  problemCount: number;
  /** How many problems of each kind, over ALL of them (not just the listed ones). Kinds with none are absent. */
  countsByKind: Partial<Record<IntegrityProblem['kind'], number>>;
  problems: IntegrityProblem[];
}

export interface VerifyLibraryOptions {
  onProgress?: (progress: IntegrityProgress) => void;
  /** Stops between files; rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Checks that every media file the library says it has is really there, intact: present in the
 * blob store, with the recorded size, and (streamed, one file at a time, never held whole) hashing
 * to its name; and that every message attachment and profile photo points at a recorded file.
 * Read-only. Runs under the archive busy guard: while an import, undo, backup or restore runs it
 * rejects with `ArchiveError` `busy` instead of reporting files that are about to appear or go.
 */
export async function verifyLibraryIntegrity(deps: ProfileDeps, options: VerifyLibraryOptions = {}): Promise<LibraryIntegrity> {
  return withArchiveGuard(
    deps.blobStore,
    async () => {
      const { mediaFiles, mediaBytes } = await deps.client.call('getLibraryStats');
      const result: LibraryIntegrity = { ok: true, checkedFiles: 0, checkedBytes: 0, problemCount: 0, countsByKind: {}, problems: [] };
      const report = (problem: IntegrityProblem) => {
        result.ok = false;
        result.problemCount++;
        result.countsByKind[problem.kind] = (result.countsByKind[problem.kind] ?? 0) + 1;
        if (result.problems.length < MAX_REPORTED_PROBLEMS) result.problems.push(problem);
      };
      const progress = () =>
        options.onProgress?.({ done: result.checkedFiles, total: mediaFiles, bytesDone: result.checkedBytes, bytesTotal: mediaBytes });
      progress();
      let after: string | undefined;
      for (;;) {
        const page = await deps.client.call('listBlobPage', { after, limit: PAGE });
        for (const row of page) {
          if (options.signal?.aborted) throw options.signal.reason;
          const actual = await deps.blobStore.size(row.sha256);
          if (actual === undefined) report({ kind: 'missing-file', sha256: row.sha256 });
          else if (actual !== row.size) report({ kind: 'wrong-size', sha256: row.sha256, expected: row.size, actual });
          else if ((await deps.blobStore.verify(row.sha256)) !== 'ok') report({ kind: 'hash-mismatch', sha256: row.sha256 });
          result.checkedFiles++;
          result.checkedBytes += row.size;
          progress();
        }
        if (page.length < PAGE) break;
        after = page[page.length - 1].sha256;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      const dangling = await deps.client.call('findDanglingBlobRefs', { limit: MAX_REPORTED_PROBLEMS });
      for (const item of dangling.items) {
        if (result.problems.length < MAX_REPORTED_PROBLEMS) result.problems.push({ kind: 'dangling-reference', ...item });
      }
      if (dangling.total > 0) {
        result.ok = false;
        result.problemCount += dangling.total;
        result.countsByKind['dangling-reference'] = dangling.total;
      }
      return result;
    },
    deps.lock,
  );
}

export interface VerifyBackupOptions {
  /** Files compared so far / files the manifest lists. */
  onProgress?: (progress: { done: number; total: number }) => void;
  signal?: AbortSignal;
  /** Tests lower the limits to stay fast. */
  limits?: Partial<ArchiveLimits>;
}

/**
 * Opens a backup ZIP and checks it without restoring anything: the manifest (format and schema
 * version known), the entry list against the ZIP, safe paths, bounded sizes, and every listed file
 * present with the size and SHA-256 the manifest records. Streams each entry; memory stays bounded.
 * A file that cannot be examined as an archive is reported as `refusal` (an `ArchiveErrorCode`),
 * not thrown. Touches no library, so it needs no guard.
 */
export function verifyBackupFile(file: Blob, options: VerifyBackupOptions = {}): Promise<BackupVerification> {
  return verifyArchive(file, {
    supportedSchemaVersion: SCHEMA_VERSION,
    limits: options.limits,
    signal: options.signal,
    onProgress: options.onProgress ? (done, total) => options.onProgress?.({ done, total }) : undefined,
  });
}

export interface ArchiveUsage {
  counts: { profiles: number; conversations: number; messages: number; mediaFiles: number };
  /** What the archive stores, in bytes. Exact for media (recorded sizes) and the database (logical size). */
  bytes: {
    media: number;
    /** The derived thumbnail cache (0 when the library has none). */
    thumbnails: number;
    database: number;
    /** The full-text search index file (0 until it is first built). */
    searchIndex: number;
  };
  /** No table of the library holds a row: the one condition restoring a backup needs (same test as the restore's own). */
  libraryEmpty: boolean;
  /** The browser's view of this app's storage; unknown parts are null. */
  device: StorageStatus;
}

/** Counts and bytes per kind, plus the browser's quota, usage and persistence flag. Read-only. */
export async function getArchiveUsage(
  deps: ProfileDeps,
  storage: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<ArchiveUsage> {
  const [stats, libraryEmpty, thumbs, device] = await Promise.all([
    deps.client.call('getLibraryStats'),
    deps.client.call('isLibraryEmpty'),
    deps.thumbStore ? deps.thumbStore.usage() : Promise.resolve({ count: 0, bytes: 0 }),
    readStorageStatus(storage),
  ]);
  return {
    counts: { profiles: stats.profiles, conversations: stats.conversations, messages: stats.messages, mediaFiles: stats.mediaFiles },
    bytes: { media: stats.mediaBytes, thumbnails: thumbs.bytes, database: stats.databaseBytes, searchIndex: stats.searchIndexBytes },
    libraryEmpty,
    device,
  };
}
