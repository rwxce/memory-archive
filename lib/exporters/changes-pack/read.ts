import { ArchiveError, DEFAULT_LIMITS, type ArchiveErrorCode, type ArchiveLimits } from '../archive/format';
import { guardedStream, openZipPackage, type OpenedZip } from '../archive/read';
import { COUNT_NAMES, MAX_RECORD_LINE_BYTES, classifyPackPath, parseChangesManifest, type ChangesPackCounts, type ChangesPackManifest } from './format';

/**
 * Reading a changes pack: the container checks of a backup (central directory, limits, safe unique
 * paths, manifest and ZIP agree on the entry set and sizes), then the record files line by line.
 * Merging (applying the records) is a separate step; this module only proves a pack is what its
 * manifest says. Takes the plain ZIP: an encrypted pack is opened first with `openBackupBlob`.
 */

export interface OpenChangesPackOptions {
  /** Newest database schema this app understands. */
  supportedSchemaVersion: number;
  limits?: Partial<ArchiveLimits>;
}

export type OpenedChangesPack = OpenedZip<ChangesPackManifest> & { limits: ArchiveLimits };

/** Throws `ArchiveError` (`not-an-archive`, `invalid-manifest`, `unsafe-path`, `newer-format`, ...); reads no record. */
export async function openChangesPack(zip: Blob, options: OpenChangesPackOptions): Promise<OpenedChangesPack> {
  const limits: ArchiveLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const opened = await openZipPackage(zip, limits, (bytes) => parseChangesManifest(bytes, options.supportedSchemaVersion, limits));
  return { ...opened, limits };
}

const encoder = new TextEncoder();
/** UTF-8 length of a decoded line; exact only when it could matter (a UTF-16 unit is at most 3 bytes), else an upper bound. */
const utf8Length = (text: string) => (text.length * 3 <= MAX_RECORD_LINE_BYTES ? text.length * 3 : encoder.encode(text).length);
const badRecord = () => new ArchiveError('integrity', 'a changes pack record file is malformed');

/**
 * The JSON objects of one record file (`records/*.jsonl`, `batches/*.jsonl`), one per line, from a
 * stream that is size-counted and hash-checked as it is read. Strict: UTF-8, every line ends with
 * `\n`, no blank lines, each line at most `MAX_RECORD_LINE_BYTES` and a JSON object. The hash and
 * size are only known to match once the generator has finished, so a caller must not commit what
 * it read before then (the merge verifies the whole pack first).
 */
export async function* readPackLines(
  zip: Blob,
  opened: OpenedChangesPack,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const item = opened.listed.get(path);
  const entry = opened.byName.get(path);
  const shape = classifyPackPath(path);
  if (!item || !entry || !shape || shape.kind === 'blob') throw new ArchiveError('entry-mismatch', 'that entry is not a record file of this pack');
  const reader = guardedStream(zip, entry, { size: item.size, maxBytes: opened.limits.maxEntryBytes, sha256: item.sha256 }, {}).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      let chunk: string;
      try {
        chunk = decoder.decode(value, { stream: !done });
      } catch {
        throw badRecord();
      }
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line === '' || utf8Length(line) > MAX_RECORD_LINE_BYTES) throw badRecord();
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw badRecord();
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw badRecord();
        yield parsed as Record<string, unknown>;
      }
      if (utf8Length(buffer) > MAX_RECORD_LINE_BYTES) throw badRecord(); // an unfinished line already too long
      if (done) break;
    }
    if (buffer !== '') throw badRecord();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** What can be wrong with one entry of an otherwise well-formed pack; `entry` is a validated pack path. */
export interface ChangesPackProblem {
  entry: string;
  code: ArchiveErrorCode | 'count-mismatch';
}

export interface ChangesPackVerification {
  ok: boolean;
  /** Set when the file could not even be examined as a pack (see `openChangesPack`). */
  refusal?: ArchiveErrorCode;
  manifest?: ChangesPackManifest;
  /** Lines actually found, to compare with `manifest.counts`; absent on a `refusal`. */
  found?: ChangesPackCounts;
  problems: ChangesPackProblem[];
}

export interface VerifyChangesPackOptions extends OpenChangesPackOptions {
  signal?: AbortSignal;
}

/**
 * Reads a pack end to end WITHOUT applying anything: every entry is streamed through a size counter
 * and SHA-256 against the manifest, every record line is parsed, and the manifest's `counts` are
 * compared with the lines found. Structural failures become `refusal`; per-entry failures become
 * `problems` and the scan goes on. Each batch file must start with a header carrying its own id.
 */
export async function verifyChangesPack(zip: Blob, options: VerifyChangesPackOptions): Promise<ChangesPackVerification> {
  let opened: OpenedChangesPack;
  try {
    opened = await openChangesPack(zip, options);
  } catch (error) {
    if (error instanceof ArchiveError) return { ok: false, refusal: error.code, problems: [] };
    throw error;
  }
  const { manifest } = opened;
  const found = Object.fromEntries(COUNT_NAMES.map((n) => [n, 0])) as unknown as ChangesPackCounts;
  const problems: ChangesPackProblem[] = [];
  const listedBlobs = new Set<string>();
  const fail = (entry: string, error: unknown) => {
    if (options.signal?.aborted) throw options.signal.reason;
    problems.push({ entry, code: error instanceof ArchiveError ? error.code : 'integrity' });
  };

  for (const item of manifest.entries) {
    if (options.signal?.aborted) throw options.signal.reason;
    const shape = classifyPackPath(item.path)!;
    if (shape.kind === 'blob') {
      found.blobs++;
      await checkBlob(zip, opened, item.path).catch((error: unknown) => fail(item.path, error));
      continue;
    }
    let lines = 0;
    try {
      for await (const record of readPackLines(zip, opened, item.path, options.signal)) {
        if (shape.kind === 'record' && shape.name === 'blobs') listedBlobs.add(String(record.sha256));
        if (shape.kind === 'batch' && lines === 0 && record.id !== shape.id) throw badRecord();
        lines++;
      }
      if (shape.kind === 'batch') {
        if (lines === 0) throw badRecord();
        found.batches++;
        found.messages += lines - 1;
      } else if (shape.name !== 'blobs') found[shape.name] += lines;
    } catch (error) {
      fail(item.path, error);
    }
  }
  // The blob records and the files under blobs/ describe the same set.
  const carried = manifest.entries.filter((e) => e.path.startsWith('blobs/'));
  if (listedBlobs.size !== carried.length || carried.some((e) => !listedBlobs.has(e.sha256))) {
    problems.push({ entry: 'records/blobs.jsonl', code: 'count-mismatch' });
  }
  // Counts are only meaningful when every entry could be read in full.
  if (problems.length === 0) {
    for (const name of COUNT_NAMES) {
      if (found[name] !== manifest.counts[name]) problems.push({ entry: 'manifest', code: 'count-mismatch' });
    }
  }
  return { ok: problems.length === 0, manifest, found, problems };
}

async function checkBlob(zip: Blob, opened: OpenedChangesPack, path: string): Promise<void> {
  const item = opened.listed.get(path)!;
  const reader = guardedStream(zip, opened.byName.get(path)!, { size: item.size, maxBytes: opened.limits.maxEntryBytes, sha256: item.sha256 }, {}).getReader();
  try {
    for (;;) if ((await reader.read()).done) return;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
