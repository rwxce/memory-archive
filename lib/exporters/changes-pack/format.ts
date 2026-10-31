import { ARCHIVE_FORMAT_NAME } from '../../domain/archive';
import { CHANGES_PACK_FORMAT_NAME, CHANGES_PACK_FORMAT_VERSION } from '../../domain/changes-pack';
import {
  ArchiveError,
  DEFAULT_LIMITS,
  blobPath,
  isSha256Hex,
  validateEntryPath,
  type ArchiveLimits,
  type ManifestEntry,
} from '../archive/format';

/**
 * The changes pack (`memory-archive-changes-YYYY-MM-DD-<device>.zip`) is a public, versioned
 * format; `docs/formats/changes-pack.md` is the specification. It is the backup's container
 * (`../archive`): the same ZIP rules, limits, hashing and blob layout, with JSON-lines record
 * files instead of a database.
 *
 *   manifest.json                 first entry, deflated
 *   records/<name>.jsonl          the six record files, always present (possibly empty)
 *   batches/<batch id>.jsonl      per import batch: header line, then its messages
 *   blobs/<aa>/<sha256>           media bytes, exactly as in the backup
 */
export { CHANGES_PACK_FORMAT_NAME, CHANGES_PACK_FORMAT_VERSION };

export const RECORD_FILES = ['profiles', 'conversations', 'blobs', 'favorites', 'notes', 'tombstones'] as const;
export type RecordFileName = (typeof RECORD_FILES)[number];

export const recordPath = (name: RecordFileName): string => `records/${name}.jsonl`;
export const batchPath = (batchId: string): string => `batches/${batchId}.jsonl`;

/** One JSON line may not be longer than this (a message body is bounded far below it). */
export const MAX_RECORD_LINE_BYTES = 4 * 1024 * 1024;

const SHORT = (deviceId: string) => deviceId.slice(0, 8);

/** `memory-archive-changes-YYYY-MM-DD-<first 8 hex of the source device id>.zip` (UTC date). */
export function changesPackFileName(date: Date, sourceDeviceId: string): string {
  return `memory-archive-changes-${date.toISOString().slice(0, 10)}-${SHORT(sourceDeviceId)}.zip`;
}

/** The same name with the encrypted envelope's extension. */
export function encryptedChangesPackFileName(date: Date, sourceDeviceId: string): string {
  return `memory-archive-changes-${date.toISOString().slice(0, 10)}-${SHORT(sourceDeviceId)}.mabackup`;
}

export interface ChangesPackCounts {
  profiles: number;
  conversations: number;
  batches: number;
  messages: number;
  favorites: number;
  notes: number;
  tombstones: number;
  blobs: number;
}

export const COUNT_NAMES = ['profiles', 'conversations', 'batches', 'messages', 'favorites', 'notes', 'tombstones', 'blobs'] as const;

export interface ChangesPackManifest {
  format: typeof CHANGES_PACK_FORMAT_NAME;
  formatVersion: number;
  createdAt: string;
  app: { name: string; version: string };
  schemaVersion: number;
  kind: 'changes' | 'full';
  source: { deviceId: string };
  /** `null` for a `full` pack. */
  target: { deviceId: string | null };
  since: number;
  upTo: number;
  ack: number | null;
  counts: ChangesPackCounts;
  /** Every entry except the manifest: record files, batches by id, blobs by hash. */
  entries: ManifestEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (why: string) => new ArchiveError('invalid-manifest', `invalid manifest: ${why}`);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type PackEntryKind = { kind: 'record'; name: RecordFileName } | { kind: 'batch'; id: string } | { kind: 'blob'; sha256: string };

/** What an entry path is, or `null` when it is none of the shapes a pack may have. */
export function classifyPackPath(path: string): PackEntryKind | null {
  for (const name of RECORD_FILES) if (path === recordPath(name)) return { kind: 'record', name };
  const batch = /^batches\/([0-9a-f-]{36})\.jsonl$/.exec(path);
  if (batch && UUID.test(batch[1])) return { kind: 'batch', id: batch[1] };
  const blob = /^blobs\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(path);
  if (blob && blob[2].slice(0, 2) === blob[1]) return { kind: 'blob', sha256: blob[2] };
  return null;
}

/**
 * Parses and strictly validates an untrusted pack manifest. `supportedSchemaVersion` is the newest
 * database schema this app understands: a pack from a newer schema is refused (`newer-schema`), a
 * newer format version too (`newer-format`). A full backup is named as such.
 */
export function parseChangesManifest(
  bytes: Uint8Array,
  supportedSchemaVersion: number,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): ChangesPackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('not valid JSON');
  }
  if (!isRecord(raw)) throw invalid('not an object');
  if (raw.format === ARCHIVE_FORMAT_NAME) throw invalid('this file is a full backup, not a changes pack');
  if (raw.format !== CHANGES_PACK_FORMAT_NAME) throw invalid('wrong format name');
  if (!isCount(raw.formatVersion) || raw.formatVersion < 1) throw invalid('formatVersion');
  if (raw.formatVersion > CHANGES_PACK_FORMAT_VERSION) {
    throw new ArchiveError(
      'newer-format',
      `this changes pack uses format version ${raw.formatVersion}, newer than this app understands (${CHANGES_PACK_FORMAT_VERSION}); update the app`,
    );
  }
  if (!isCount(raw.schemaVersion) || raw.schemaVersion < 1) throw invalid('schemaVersion');
  if (raw.schemaVersion > supportedSchemaVersion) {
    throw new ArchiveError(
      'newer-schema',
      `this changes pack was made with database schema ${raw.schemaVersion}, newer than this app understands (${supportedSchemaVersion}); update the app`,
    );
  }
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length > 40 || Number.isNaN(Date.parse(raw.createdAt))) throw invalid('createdAt');
  const app = raw.app;
  if (!isRecord(app) || typeof app.name !== 'string' || typeof app.version !== 'string' || app.name.length > 100 || app.version.length > 100) {
    throw invalid('app');
  }
  if (raw.kind !== 'changes' && raw.kind !== 'full') throw invalid('kind');
  if (!isRecord(raw.source) || !isUuid(raw.source.deviceId)) throw invalid('source');
  if (!isRecord(raw.target)) throw invalid('target');
  const targetId = raw.target.deviceId;
  if (raw.kind === 'changes' ? !isUuid(targetId) : targetId !== null) throw invalid('target');
  if (targetId === raw.source.deviceId) throw invalid('a pack cannot be for the device that made it');
  if (!isCount(raw.since) || !isCount(raw.upTo) || raw.since > raw.upTo) throw invalid('since / upTo');
  if (raw.kind === 'full' && raw.since !== 0) throw invalid('a full pack starts at 0');
  if (raw.ack !== null && !isCount(raw.ack)) throw invalid('ack');
  if (raw.kind === 'full' && raw.ack !== null) throw invalid('a full pack has no target to acknowledge');
  if (!isRecord(raw.counts)) throw invalid('counts');
  const counts = {} as ChangesPackCounts;
  for (const name of COUNT_NAMES) {
    const value = raw.counts[name];
    if (!isCount(value)) throw invalid('counts');
    counts[name] = value;
  }
  if (!Array.isArray(raw.entries)) throw invalid('entries');
  if (raw.entries.length + 1 > limits.maxEntries) throw new ArchiveError('limit-exceeded', 'the manifest lists too many entries');

  const seen = new Set<string>();
  let total = 0;
  let batches = 0;
  let blobs = 0;
  const records = new Set<string>();
  const entries: ManifestEntry[] = raw.entries.map((item: unknown) => {
    if (!isRecord(item) || typeof item.path !== 'string' || !isCount(item.size) || !isSha256Hex(item.sha256)) throw invalid('entry');
    const entry: ManifestEntry = { path: item.path, size: item.size, sha256: item.sha256 };
    validateEntryPath(entry.path);
    const shape = classifyPackPath(entry.path);
    if (!shape) throw invalid('an entry has a path a changes pack never has');
    if (shape.kind === 'blob') {
      if (shape.sha256 !== entry.sha256 || entry.path !== blobPath(entry.sha256)) throw invalid('a blob is not named by its own hash');
      blobs++;
    } else if (shape.kind === 'batch') batches++;
    else records.add(shape.name);
    if (seen.has(entry.path)) throw new ArchiveError('duplicate-entry', 'manifest lists the same path twice');
    seen.add(entry.path);
    if (entry.size > limits.maxEntryBytes) throw new ArchiveError('limit-exceeded', 'a listed entry is too large');
    total += entry.size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('limit-exceeded', 'the changes pack is too large');
    return entry;
  });
  if (records.size !== RECORD_FILES.length) throw invalid('every record file must be listed');
  if (counts.batches !== batches || counts.blobs !== blobs) throw invalid('counts do not match the listed entries');

  return {
    format: CHANGES_PACK_FORMAT_NAME,
    formatVersion: raw.formatVersion,
    createdAt: raw.createdAt,
    app: { name: app.name, version: app.version },
    schemaVersion: raw.schemaVersion,
    kind: raw.kind,
    source: { deviceId: raw.source.deviceId },
    target: { deviceId: targetId as string | null },
    since: raw.since,
    upTo: raw.upTo,
    ack: raw.ack as number | null,
    counts,
    entries,
  };
}
