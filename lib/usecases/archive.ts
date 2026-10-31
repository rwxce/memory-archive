import { checkSnapshot, exportDatabase, isLibraryEmpty, loadSnapshot } from '../db/snapshot';
import type { SqlDb } from '../db/sql';
import type { RestoreResult } from '../exporters/archive/read';
import type { BlobStore } from '../storage/blob-store';
import type { ThumbStore } from '../storage/thumb-store';
import type { ArchiveLock } from './archive-guard';
import {
  exportParts,
  restoreParts,
  type ArchiveDatabase,
  type ExportArchiveOptions,
  type ExportArchiveResult,
  type RestoreArchiveOptions,
} from './archive-core';

/*
 * Export and restore for a library whose SQLite handle is in THIS thread (tests, Node). The PWA
 * uses `archive-backup.ts`, which never imports SQLite code.
 */
export { ARCHIVE_LOCK_NAME, webArchiveLock, withArchiveGuard, ArchiveError } from './archive-core';
export type {
  ArchiveErrorCode,
  ArchiveLock,
  ArchiveProgress,
  ExportArchiveOptions,
  ExportArchiveResult,
  RestoreArchiveOptions,
} from './archive-core';
export { exportArchiveFromLibrary, replaceLibraryFromBackup, restoreArchiveFromZip } from './archive-backup';

const directDatabase = (db: SqlDb): ArchiveDatabase => ({
  snapshot: async () => exportDatabase(db),
  isEmpty: async () => isLibraryEmpty(db),
  check: async (database, blobs) => {
    await checkSnapshot(db, database, { expectBlobs: blobs });
  },
  load: async (database, blobs, options) => {
    await loadSnapshot(db, database, { expectBlobs: blobs, replace: options?.replace, unchangedSince: options?.unchangedSince });
  },
});

export interface ArchiveLibrary {
  db: SqlDb;
  blobStore: BlobStore;
  /** The derived thumbnail cache. Never exported; cleared by a restore, which starts from none. */
  thumbStore?: ThumbStore;
  /** Cross-tab lock, when the app has one (see `ArchiveLock`). */
  lock?: ArchiveLock;
}

/**
 * Backs up the whole library (database + media) as one archive ZIP. Fails
 * without producing a file when a media file is missing or damaged.
 * This form holds the SQLite handle in this thread; the PWA uses `exportArchiveFromLibrary`.
 */
export async function exportArchive(library: ArchiveLibrary, options: ExportArchiveOptions): Promise<ExportArchiveResult> {
  return exportParts({ ...library, database: directDatabase(library.db) }, options);
}

/**
 * Restores an archive ZIP into a library that has no rows. Media files without a database row are leftovers and are swept first;
 * a library with rows is refused with `target-not-empty`: merging into an
 * existing library is a different operation. All or nothing.
 * This form holds the SQLite handle in this thread; the PWA uses `restoreArchiveFromZip`.
 */
export async function restoreArchiveIntoEmptyLibrary(
  library: ArchiveLibrary,
  zip: Blob,
  options: RestoreArchiveOptions = {},
): Promise<RestoreResult> {
  return restoreParts({ ...library, database: directDatabase(library.db) }, zip, options);
}
