import { describe, expect, test } from 'vitest';
import { ARCHIVE_FORMAT_NAME } from '../../domain/archive';
import { ArchiveError, DEFAULT_LIMITS, parseManifest } from '../archive/format';
import { RECORD_FILES, changesPackFileName, classifyPackPath, encryptedChangesPackFileName, parseChangesManifest, recordPath } from './format';
import { IDS, MEDIA_SHA } from './test-pack';

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const entry = (path: string, sha256 = 'a'.repeat(64)) => ({ path, size: 1, sha256 });
const base = () => ({
  format: 'memory-archive-changes',
  formatVersion: 1,
  createdAt: '2026-05-06T00:00:00.000Z',
  app: { name: 'memory-archive', version: '1' },
  schemaVersion: 8,
  kind: 'changes',
  source: { deviceId: IDS.source },
  target: { deviceId: IDS.target },
  since: 1,
  upTo: 5,
  ack: null,
  counts: { profiles: 0, conversations: 0, batches: 0, messages: 0, favorites: 0, notes: 0, tombstones: 0, blobs: 0 },
  entries: RECORD_FILES.map((n) => entry(recordPath(n))),
});
const parse = (manifest: unknown, schema = 8) => parseChangesManifest(enc(manifest), schema);
const codeOf = (manifest: unknown, schema = 8) => {
  try {
    parse(manifest, schema);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return (error as ArchiveError).code;
  }
  return 'accepted';
};

describe('changes pack names and paths', () => {
  test('file names carry the date and the first 8 hex of the source device', () => {
    const date = new Date('2026-03-04T23:59:59Z');
    expect(changesPackFileName(date, IDS.source)).toBe('memory-archive-changes-2026-03-04-00000000.zip');
    expect(encryptedChangesPackFileName(date, 'abcdef01-0000-4000-8000-000000000000')).toBe('memory-archive-changes-2026-03-04-abcdef01.mabackup');
  });

  test('only the exact entry shapes classify', () => {
    expect(classifyPackPath('records/notes.jsonl')).toEqual({ kind: 'record', name: 'notes' });
    expect(classifyPackPath(`batches/${IDS.batch}.jsonl`)).toEqual({ kind: 'batch', id: IDS.batch });
    expect(classifyPackPath(`blobs/${MEDIA_SHA.slice(0, 2)}/${MEDIA_SHA}`)).toEqual({ kind: 'blob', sha256: MEDIA_SHA });
    for (const bad of ['db/library.sqlite', 'records/other.jsonl', 'batches/x.jsonl', 'batches/0000000A-0000-4000-8000-000000000000.jsonl', `blobs/ff/${MEDIA_SHA}`, 'records/notes.jsonl/']) {
      expect(classifyPackPath(bad)).toBeNull();
    }
  });
});

describe('parseChangesManifest', () => {
  test('accepts a valid changes manifest and a valid full one', () => {
    expect(parse(base())).toMatchObject({ kind: 'changes', since: 1, upTo: 5, ack: null });
    expect(parse({ ...base(), kind: 'full', since: 0, target: { deviceId: null } })).toMatchObject({ kind: 'full', target: { deviceId: null } });
  });

  test('refuses what an old reader could misread: newer format, newer schema', () => {
    expect(codeOf({ ...base(), formatVersion: 2 })).toBe('newer-format');
    expect(codeOf({ ...base(), schemaVersion: 9 })).toBe('newer-schema');
    expect(codeOf(base(), 7)).toBe('newer-schema');
  });

  test('a full backup and a pack name each other in the error, not "wrong format"', () => {
    expect(() => parse({ ...base(), format: ARCHIVE_FORMAT_NAME })).toThrow(/full backup, not a changes pack/);
    expect(() => parseManifest(enc(base()), 8)).toThrow(/changes pack, not a full backup/);
  });

  test.each([
    ['kind', { kind: 'other' }],
    ['a changes pack without a target', { target: { deviceId: null } }],
    ['a full pack with a target', { kind: 'full', since: 0 }],
    ['a full pack that does not start at 0', { kind: 'full', since: 1, target: { deviceId: null } }],
    ['a pack for its own device', { target: { deviceId: IDS.source } }],
    ['since above upTo', { since: 6 }],
    ['a negative ack', { ack: -1 }],
    ['a full pack with an ack', { kind: 'full', since: 0, target: { deviceId: null }, ack: 3 }],
    ['a non-integer upTo', { upTo: 1.5 }],
    ['a missing count', { counts: { profiles: 0 } }],
    ['counts that disagree with the listed blobs', { counts: { ...base().counts, blobs: 1 } }],
    ['a missing record file', { entries: base().entries.slice(1) }],
    ['a database entry', { entries: [...base().entries, entry('db/library.sqlite')] }],
    ['a blob not named by its hash', { entries: [...base().entries, entry(`blobs/${MEDIA_SHA.slice(0, 2)}/${MEDIA_SHA}`)], counts: { ...base().counts, blobs: 1 } }],
    ['entries that are not a list', { entries: {} }],
  ])('refuses %s', (_name, patch) => {
    expect(codeOf({ ...base(), ...patch })).toBe('invalid-manifest');
  });

  test('hostile paths and duplicates', () => {
    expect(codeOf({ ...base(), entries: [...base().entries, entry('../records/x.jsonl')] })).toBe('unsafe-path');
    expect(codeOf({ ...base(), entries: [...base().entries, entry('/etc/passwd')] })).toBe('unsafe-path');
    expect(codeOf({ ...base(), entries: [...base().entries, entry(recordPath('notes'))] })).toBe('duplicate-entry');
  });

  test('limits on entries and sizes apply', () => {
    expect(() => parseChangesManifest(enc(base()), 8, { ...DEFAULT_LIMITS, maxEntries: 3 })).toThrow(/too many/);
    expect(() => parseChangesManifest(enc(base()), 8, { ...DEFAULT_LIMITS, maxEntryBytes: 0 })).toThrow(/too large/);
    expect(() => parseChangesManifest(enc(base()), 8, { ...DEFAULT_LIMITS, maxTotalBytes: 2 })).toThrow(/too large/);
    expect(() => parseChangesManifest(new TextEncoder().encode('{nope'), 8)).toThrow(/not valid JSON/);
  });
});
