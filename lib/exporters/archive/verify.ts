import { createSha256 } from '../../domain/sha256';
import { openZipEntry } from '../../importers/whatsapp/zip';
import { ArchiveError, DB_PATH, DEFAULT_LIMITS, type ArchiveErrorCode, type ArchiveLimits } from './format';
import { openArchive } from './read';

/**
 * What can be wrong with one entry of an otherwise well-formed archive. Entries are named by what
 * they are (the database, or a media file by its hash), never by the ZIP's own strings.
 */
export type BackupProblem =
  | { kind: 'size-mismatch'; entry: 'database' | 'blob'; sha256: string }
  | { kind: 'hash-mismatch'; entry: 'database' | 'blob'; sha256: string }
  /** The entry could not be read (damaged data), or grew past its limit while reading. */
  | { kind: 'unreadable'; entry: 'database' | 'blob'; sha256: string };

export interface BackupVerification {
  /**
   * The archive is well-formed and every listed file has the size and SHA-256 the manifest records.
   * That is all this checks: it does not load the database snapshot, so a restore can still be refused
   * for what is inside it (for example `invalid-database`).
   */
  ok: boolean;
  /**
   * Set when the file could not even be examined as an archive (not a ZIP, truncated, bad or newer
   * manifest, unsafe path, entries and manifest disagree, over the limits). Then nothing else is known.
   */
  refusal?: ArchiveErrorCode;
  /** From the manifest; absent on a `refusal`. */
  formatVersion?: number;
  schemaVersion?: number;
  createdAt?: string;
  appVersion?: string;
  /** Files listed by the manifest (the database counts as one), and how many were read and compared. */
  totalEntries: number;
  checkedEntries: number;
  /** All problems found, but `problems` keeps only the first `maxProblems`. */
  problemCount: number;
  problems: BackupProblem[];
}

export interface VerifyArchiveOptions {
  limits?: Partial<ArchiveLimits>;
  /** Newest database schema this app understands. */
  supportedSchemaVersion: number;
  /** Called before the first file (done 0) and after each one. */
  onProgress?: (done: number, total: number) => void;
  /** Stops between chunks; rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Problems kept in the result. Default 100. */
  maxProblems?: number;
}

/**
 * Reads an archive ZIP end to end and compares every file with the manifest, WITHOUT restoring
 * anything and without keeping a file in memory: each entry is streamed through a size counter and
 * SHA-256. Structural failures (see `openArchive`) become `refusal`; per-file failures become
 * `problems`, and the scan continues so one bad photo does not hide a second one.
 */
export async function verifyArchive(zip: Blob, options: VerifyArchiveOptions): Promise<BackupVerification> {
  const limits: ArchiveLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const maxProblems = options.maxProblems ?? 100;
  let opened;
  try {
    opened = await openArchive(zip, options.supportedSchemaVersion, limits);
  } catch (error) {
    if (error instanceof ArchiveError) return { ok: false, refusal: error.code, totalEntries: 0, checkedEntries: 0, problemCount: 0, problems: [] };
    throw error;
  }
  const { manifest, byName } = opened;
  const result: BackupVerification = {
    ok: true,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    appVersion: manifest.app.version,
    totalEntries: manifest.entries.length,
    checkedEntries: 0,
    problemCount: 0,
    problems: [],
  };
  options.onProgress?.(0, result.totalEntries);
  for (const item of manifest.entries) {
    if (options.signal?.aborted) throw options.signal.reason;
    const entry = byName.get(item.path)!;
    const kind = item.path === DB_PATH ? 'database' : 'blob';
    const maxBytes = kind === 'database' ? limits.maxDatabaseBytes : limits.maxEntryBytes;
    const problem = await checkEntry(openZipEntry(zip, entry), item.size, item.sha256, maxBytes, options.signal);
    if (problem) {
      result.ok = false;
      result.problemCount++;
      if (result.problems.length < maxProblems) result.problems.push({ kind: problem, entry: kind, sha256: item.sha256 });
    }
    result.checkedEntries++;
    options.onProgress?.(result.checkedEntries, result.totalEntries);
  }
  return result;
}

async function checkEntry(
  stream: ReadableStream<Uint8Array>,
  size: number,
  sha256: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<BackupProblem['kind'] | undefined> {
  const reader = stream.getReader();
  const hasher = createSha256();
  let actual = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      actual += value.length;
      // Declared sizes are attacker-controlled: stop at the real cap, not at what the header claims.
      if (actual > maxBytes || actual > size) return actual > maxBytes ? 'unreadable' : 'size-mismatch';
      hasher.update(value);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return 'unreadable';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (actual !== size) return 'size-mismatch';
  return hasher.digestHex() === sha256 ? undefined : 'hash-mismatch';
}
