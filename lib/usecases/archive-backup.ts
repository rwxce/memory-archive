import type { RestoreResult } from '../exporters/archive/read';
import {
  clientDatabase,
  exportParts,
  restoreParts,
  type ExportArchiveOptions,
  type ExportArchiveResult,
  type RestoreArchiveOptions,
} from './archive-core';
import type { ProfileDeps } from './profiles';

export { ArchiveError } from './archive-core';
export type { ArchiveErrorCode, ArchiveProgress, ExportArchiveOptions, ExportArchiveResult, RestoreArchiveOptions } from './archive-core';

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
