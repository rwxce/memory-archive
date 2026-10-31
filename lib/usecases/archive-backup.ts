import type { RestoreResult } from '../exporters/archive/read';
import {
  clientDatabase,
  exportParts,
  replaceParts,
  restoreParts,
  type ExportArchiveOptions,
  type ExportArchiveResult,
  type ReplaceLibraryOptions,
  type ReplaceLibraryResult,
  type RestoreArchiveOptions,
} from './archive-core';
import type { ProfileDeps } from './profiles';

export { ArchiveError } from './archive-core';
export { isEncryptedBackup } from '../exporters/archive/encrypt';
export type { CryptoProgress } from '../exporters/archive/encrypt';
export type {
  ArchiveErrorCode,
  ArchiveProgress,
  ExportArchiveOptions,
  ExportArchiveResult,
  ReplaceLibraryOptions,
  ReplaceLibraryResult,
  ReplaceProgress,
  RestoreArchiveOptions,
} from './archive-core';

/*
 * The PWA's backup and restore. This module (and everything it imports) must stay free of SQLite
 * code: the page reaches the database only through `deps.client`, and bundling sqlite-wasm into
 * the page breaks the build. The in-thread form (tests, Node) lives in `archive.ts`.
 */

/**
 * The PWA's backup: the same archive, with the database read from its worker through
 * `deps.client`. Heavy part to know about: the database bytes (up to `maxDatabaseBytes`, 512 MB)
 * are copied once across the worker boundary and held in memory with the zipped output's
 * pending chunks (see `writeArchive`); media files are streamed one chunk at a time and never held whole.
 * The result is a `Blob` to offer as a download (`fileName`). Rejects with `ArchiveError`
 * (`busy`, `limit-exceeded`, `blob-missing`, `integrity`, `storage`).
 */
export async function exportArchiveFromLibrary(deps: ProfileDeps, options: ExportArchiveOptions): Promise<ExportArchiveResult> {
  return exportParts({ ...deps, database: clientDatabase(deps.client) }, options);
}

/**
 * The PWA's restore ("Open an archive"): `zip` is the `File` the person picked (read as a
 * stream, never loaded whole); the database goes to its worker through `deps.client`. The
 * database entry (up to 512 MB) is held in memory once and copied across the worker boundary;
 * media files are streamed into the blob store. Refuses a library that already has data
 * (`target-not-empty`), all or nothing. Rejects with `ArchiveError` (`busy`, `target-not-empty`,
 * `not-an-archive`, `invalid-manifest`, `unsafe-path`, `duplicate-entry`, `entry-mismatch`,
 * `limit-exceeded`, `integrity`, `newer-format`, `newer-schema`, `invalid-database`, `storage`).
 * After it resolves the caller reloads whatever it shows (`refresh()`).
 */
export async function restoreArchiveFromZip(deps: ProfileDeps, zip: Blob, options: RestoreArchiveOptions = {}): Promise<RestoreResult> {
  return restoreParts({ ...deps, database: clientDatabase(deps.client) }, zip, options);
}

/**
 * "Replace this archive with a backup": the chosen backup replaces everything in the library
 * (profiles, conversations, messages, notes, favorites, media, thumbnails; NOT app settings).
 * Order, all under the archive guard: (1) the backup is verified completely (manifest, sizes,
 * SHA-256 of every file); a failure refuses with the verification's `ArchiveError` code and nothing
 * is touched; (2) its database is checked in a scratch copy (`invalid-database` / `newer-schema`;
 * an older schema is migrated), still before anything is stored or handed over; (3) if the library
 * has data, its safety backup is built and handed to `options.deliverSafetyBackup`, and nothing goes
 * on until that resolves (a failure, or a library too large to back up, is `safety-backup-failed`
 * and changes nothing); (4) the backup's media are stored beside the current ones (same hash = one
 * file), then the database is swapped in ONE transaction that first checks the library is still
 * byte-identical to what the safety backup saw (`changed-during-replace` otherwise: a note, favorite
 * or profile edit made meanwhile is not lost; nothing is replaced, try again); (5) old media nothing
 * references any more and the thumbnails are deleted.
 * Atomicity: the library is never erased first. Any failure or abort up to the commit of step 4
 * leaves it exactly as it was (only the files this replace added are removed), so there is no
 * "erased but not restored" state. The price is that the current and the new media coexist on
 * disk for a moment, so a nearly full device fails with `storage` (nothing changed). The one
 * exception: if the worker dies before answering the swap, whether it committed is unknown, so the
 * new media are kept and counted in the error's `leftoverBlobs`. Step 5 failures only leave harmless
 * orphans (`leftoverBlobs` in the result). Orphans are removed by the next library open
 * (`sweepLeftovers`, which needs Web Locks) or the next replace; a restore into an empty library also clears them.
 * `signal` is honored until the swap starts; an abort rejects with the signal's reason.
 * Rejects with `ArchiveError` (`busy`, `safety-backup-failed`, `changed-during-replace`, plus every restore
 * code except `target-not-empty`). The quick writes (notes, favorites, profile edits) do not take the
 * archive guard, so `changed-during-replace` is what protects them. After it resolves the caller
 * reloads whatever it shows (`refresh()`).
 */
export async function replaceLibraryFromBackup(deps: ProfileDeps, file: Blob, options: ReplaceLibraryOptions): Promise<ReplaceLibraryResult> {
  return replaceParts({ ...deps, database: clientDatabase(deps.client) }, file, options);
}
