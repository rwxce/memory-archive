import { ARCHIVE_FORMAT_NAME, ARCHIVE_FORMAT_VERSION } from '../../domain/archive';
import { CHANGES_PACK_FORMAT_NAME } from '../../domain/changes-pack';

/**
 * The archive file (`memory-archive-YYYY-MM-DD.zip`) is a public, versioned
 * format. Layout of format version 1:
 *
 *   manifest.json            first entry, deflated; describes everything below
 *   db/library.sqlite        the SQLite database file (stored)
 *   blobs/<aa>/<sha256>      one entry per `blobs` row, named by the SHA-256
 *                            of its bytes, `<aa>` = its first two hex digits (stored)
 *
 * Media is already compressed (JPEG, MP4, ...) and SQLite pages are read back
 * as a whole, so those entries are stored uncompressed: no CPU spent for no
 * gain, and restore can cap every entry by its exact byte count. The manifest
 * is small JSON and is deflated.
 */
export const MANIFEST_PATH = 'manifest.json';
export const DB_PATH = 'db/library.sqlite';
export const APP_NAME = 'memory-archive';

export function blobPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

/** `memory-archive-YYYY-MM-DD.zip` (UTC date). */
export function archiveFileName(date: Date): string {
  return `memory-archive-${date.toISOString().slice(0, 10)}.zip`;
}

/** `memory-archive-YYYY-MM-DD.mabackup` (UTC date): the encrypted envelope, not a ZIP. */
export function encryptedArchiveFileName(date: Date): string {
  return `memory-archive-${date.toISOString().slice(0, 10)}.mabackup`;
}

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT_NAME;
  formatVersion: number;
  /** UTC instant (ISO 8601). */
  createdAt: string;
  app: { name: string; version: string };
  /** `PRAGMA user_version` of `db/library.sqlite`. */
  schemaVersion: number;
  /** Every entry except the manifest itself: the database first, then blobs by hash. */
  entries: ManifestEntry[];
}

/** Hard bounds applied to an untrusted archive; tests override them to stay fast. */
export interface ArchiveLimits {
  /** Entries in the ZIP (blobs + database + manifest). */
  maxEntries: number;
  /** Sum of all uncompressed sizes. */
  maxTotalBytes: number;
  /** One entry's uncompressed size (media). */
  maxEntryBytes: number;
  /** Uncompressed size of `db/library.sqlite`, held in memory while it is verified. */
  maxDatabaseBytes: number;
  /** Declared size of the ZIP central directory, which is read whole. */
  maxCentralDirectoryBytes: number;
  /** Uncompressed size of the manifest. */
  maxManifestBytes: number;
  /** Uncompressed / compressed bytes of a deflated entry (zip-bomb guard). */
  maxCompressionRatio: number;
}

export const MAX_ENTRIES = 200_000;
export const MAX_TOTAL_BYTES = 256 * 1024 ** 3;
export const MAX_ENTRY_BYTES = 4 * 1024 ** 3;
/** The database is buffered (verify, then deserialize), so it gets its own, much lower cap. */
export const MAX_DATABASE_BYTES = 512 * 1024 ** 2;
export const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 ** 2;
export const MAX_MANIFEST_BYTES = 64 * 1024 ** 2;
export const MAX_COMPRESSION_RATIO = 100;
export { COMPRESSION_RATIO_FLOOR_BYTES } from '../../importers/whatsapp/zip';

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: MAX_ENTRIES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxDatabaseBytes: MAX_DATABASE_BYTES,
  maxCentralDirectoryBytes: MAX_CENTRAL_DIRECTORY_BYTES,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
};

export type ArchiveErrorCode =
  /** Restore target already has data. */
  | 'target-not-empty'
  /** Another export or restore is running on this library. */
  | 'busy'
  /** Not a readable ZIP. */
  | 'not-an-archive'
  | 'invalid-manifest'
  | 'unsafe-path'
  | 'duplicate-entry'
  /** ZIP entries and manifest entries disagree. */
  | 'entry-mismatch'
  | 'limit-exceeded'
  /** Bytes do not match the recorded hash or size. */
  | 'integrity'
  | 'newer-format'
  | 'newer-schema'
  | 'invalid-database'
  /** Export: a database row points at a blob that is missing or has the wrong size. */
  | 'blob-missing'
  /** Replace: the safety backup of the current library could not be built or handed over; nothing was changed. */
  | 'safety-backup-failed'
  /** Replace: the library was edited (a note, a favorite, a profile) after its safety backup was made; nothing was changed. Try again. */
  | 'changed-during-replace'
  /** The backup is encrypted and no password was given (or an empty one). */
  | 'password-required'
  /** The key check failed: wrong password (or a header damaged so the key differs). */
  | 'wrong-password'
  /** WebCrypto is missing (insecure context), so a backup cannot be encrypted or opened. */
  | 'encryption-unavailable'
  | 'storage';

/** Messages never contain file names, chat text or author names. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  /** Restore: media files a failed restore could not delete, or (replace, outcome unknown) deliberately kept; no row points at them, the next library open (`sweepLeftovers`) or replace removes them. */
  leftoverBlobs = 0;
  constructor(code: ArchiveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_PATH_LENGTH = 200;

export const isSha256Hex = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);

/**
 * Rejects anything that could ever become a path outside the archive:
 * traversal (`..`, `.`), absolute paths, backslashes, drive letters, empty
 * segments and directory entries, control and non-ASCII characters. Entries
 * are never written to disk by name (blobs go by hash), this is defense in
 * depth for the names themselves.
 */
export function validateEntryPath(path: string): void {
  const bad = (why: string) => new ArchiveError('unsafe-path', `unsafe archive entry path (${why})`);
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) throw bad('length');
  if (!/^[\x21-\x7e]+$/.test(path)) throw bad('characters');
  if (path.includes('\\')) throw bad('backslash');
  if (path.startsWith('/')) throw bad('absolute');
  if (/^[a-zA-Z]:/.test(path)) throw bad('drive letter');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw bad('segment');
  }
}

/** The only shapes an entry of format version 1 may have. */
function validateListedPath(entry: ManifestEntry): void {
  validateEntryPath(entry.path);
  if (entry.path === DB_PATH) return;
  const match = /^blobs\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(entry.path);
  if (!match || match[2].slice(0, 2) !== match[1] || match[2] !== entry.sha256) {
    throw new ArchiveError('invalid-manifest', 'manifest lists an entry that is neither the database nor a blob of its own hash');
  }
}

const invalid = (why: string) => new ArchiveError('invalid-manifest', `invalid manifest: ${why}`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Parses and strictly validates an untrusted manifest. `supportedSchemaVersion`
 * is the newest database schema this app understands (the exporter layer does
 * not know the database). Newer format or schema versions are refused with a
 * clear error instead of being guessed at.
 */
export function parseManifest(
  bytes: Uint8Array,
  supportedSchemaVersion: number,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): ArchiveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('not valid JSON');
  }
  if (!isRecord(raw)) throw invalid('not an object');
  if (raw.format === CHANGES_PACK_FORMAT_NAME) throw invalid('this file is a changes pack, not a full backup');
  if (raw.format !== ARCHIVE_FORMAT_NAME) throw invalid('wrong format name');
  if (!isCount(raw.formatVersion) || raw.formatVersion < 1) throw invalid('formatVersion');
  if (raw.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      'newer-format',
      `this archive uses format version ${raw.formatVersion}, newer than this app understands (${ARCHIVE_FORMAT_VERSION}); update the app`,
    );
  }
  if (!isCount(raw.schemaVersion) || raw.schemaVersion < 1) throw invalid('schemaVersion');
  if (raw.schemaVersion > supportedSchemaVersion) {
    throw new ArchiveError(
      'newer-schema',
      `this archive was made with database schema ${raw.schemaVersion}, newer than this app understands (${supportedSchemaVersion}); update the app`,
    );
  }
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length > 40 || Number.isNaN(Date.parse(raw.createdAt))) {
    throw invalid('createdAt');
  }
  const app = raw.app;
  if (
    !isRecord(app) ||
    typeof app.name !== 'string' ||
    typeof app.version !== 'string' ||
    app.name.length > 100 ||
    app.version.length > 100
  ) {
    throw invalid('app');
  }
  if (!Array.isArray(raw.entries)) throw invalid('entries');
  if (raw.entries.length + 1 > limits.maxEntries) {
    throw new ArchiveError('limit-exceeded', 'the manifest lists too many entries');
  }

  const seen = new Set<string>();
  let total = 0;
  const entries: ManifestEntry[] = raw.entries.map((item: unknown) => {
    if (!isRecord(item) || typeof item.path !== 'string' || !isCount(item.size) || !isSha256Hex(item.sha256)) {
      throw invalid('entry');
    }
    const entry: ManifestEntry = { path: item.path, size: item.size, sha256: item.sha256 };
    validateListedPath(entry);
    if (seen.has(entry.path)) throw new ArchiveError('duplicate-entry', 'manifest lists the same path twice');
    seen.add(entry.path);
    if (entry.size > (entry.path === DB_PATH ? limits.maxDatabaseBytes : limits.maxEntryBytes)) throw new ArchiveError('limit-exceeded', 'a listed entry is too large');
    total += entry.size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('limit-exceeded', 'the archive is too large');
    return entry;
  });
  if (entries.filter((e) => e.path === DB_PATH).length !== 1) throw invalid('exactly one database entry is required');

  return {
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: raw.formatVersion,
    createdAt: raw.createdAt,
    app: { name: app.name, version: app.version },
    schemaVersion: raw.schemaVersion,
    entries,
  };
}
