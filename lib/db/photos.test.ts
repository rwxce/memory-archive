import { describe, expect, test } from 'vitest';
import { openMemoryDb } from './open';
import { countPhotoItems, importPhotoItems, listPhotoBatches, listPhotoItems, undoPhotoBatch, type ImportPhotoItemsInput } from './photos';
import type { SqlDb } from './sql';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const B1 = '00000000-0000-4000-8000-000000000001';
const B2 = '00000000-0000-4000-8000-000000000002';

const item = (over: Record<string, unknown> = {}) => ({
  sha256: A,
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: '2019-07-01T10:00:00Z',
  takenOffsetMinutes: null,
  dateSource: 'sidecar',
  latitude: null,
  longitude: null,
  description: '',
  album: 'Trip',
  fileName: 'a.jpg',
  ...over,
});
const input = (over: Record<string, unknown> = {}): ImportPhotoItemsInput =>
  ({
    batchId: B1,
    source: 'takeout',
    sourceLabel: 'file.zip',
    now: '2026-03-01T10:00:00.000Z',
    blobs: [{ sha256: A, size: 3, mime: 'image/jpeg' }],
    items: [item()],
    ...over,
  }) as unknown as ImportPhotoItemsInput;

async function db(): Promise<SqlDb> {
  return (await openMemoryDb()).db;
}

const snapshot = (d: SqlDb) => JSON.stringify(['blobs', 'photo_batches', 'photo_items'].map((t) => d.all(`SELECT * FROM ${t} ORDER BY rowid`)));

describe('importPhotoItems', () => {
  test('stores the batch, the blob row and the items; an identical import changes nothing and leaves no batch', async () => {
    const d = await db();
    expect(importPhotoItems(d, input())).toEqual({ batchId: B1, added: 1, skipped: 0, unreferencedBlobs: [] });
    const before = snapshot(d);
    expect(importPhotoItems(d, input({ batchId: B2 }))).toEqual({ batchId: null, added: 0, skipped: 1, unreferencedBlobs: [] });
    expect(snapshot(d)).toBe(before);
    expect(listPhotoBatches(d)).toEqual([{ id: B1, source: 'takeout', sourceLabel: 'file.zip', createdAt: '2026-03-01T10:00:00.000Z', addedCount: 1, skippedCount: 0 }]);
  });

  test('a file stored for an import that adds nothing new is released (the caller deletes the bytes)', async () => {
    const d = await db();
    importPhotoItems(d, input());
    const result = importPhotoItems(
      d,
      input({ batchId: B2, blobs: [{ sha256: A, size: 3, mime: null }, { sha256: B, size: 1, mime: null }], items: [item()] }),
    );
    expect(result.unreferencedBlobs).toEqual([B]);
    expect(d.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: A }]);
  });

  test('limits count code points: the importer own maximum of emoji is accepted, one more is not', async () => {
    const d = await db();
    const ok = item({ description: '😀'.repeat(4000), album: '😀'.repeat(200), fileName: '😀'.repeat(255) });
    expect(importPhotoItems(d, input({ items: [ok] })).added).toBe(1);
    expect(() => importPhotoItems(d, input({ batchId: B2, items: [item({ album: '😀'.repeat(201) })] }))).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });

  test('the same file in another album is another item over the same blob', async () => {
    const d = await db();
    importPhotoItems(d, input());
    expect(importPhotoItems(d, input({ batchId: B2, items: [item({ album: 'Other' })] })).added).toBe(1);
    expect(countPhotoItems(d)).toBe(2);
    expect(d.all('SELECT count(*) AS n FROM blobs')).toEqual([{ n: 1 }]);
  });

  test.each([
    ['a batch id that is not a UUID', { batchId: 'x' }],
    ['an empty source', { source: '' }],
    ['a source label that is not text', { sourceLabel: 5 }],
    ['items that are not a list', { items: {} }],
    ['an item that is not an object', { items: [null] }],
    ['a hash that is not hex', { items: [item({ sha256: 'AB'.repeat(32) })], blobs: [{ sha256: 'AB'.repeat(32), size: 1, mime: null }] }],
    ['an item whose file is not in blobs', { items: [item({ sha256: B })] }],
    ['a blob with a negative size', { blobs: [{ sha256: A, size: -1, mime: null }] }],
    ['a blob with a bad media type', { blobs: [{ sha256: A, size: 1, mime: 'nope' }] }],
    ['a kind that is not photo or video', { items: [item({ kind: 'audio' })] }],
    ['a bad media type', { items: [item({ mime: '../../x' })] }],
    ['a date that is not a UTC instant', { items: [item({ takenAt: '2019-07-01T10:00:00' })] }],
    ['a date that is not real', { items: [item({ takenAt: '2019-02-31T10:00:00Z' })] }],
    ['a date source that is unknown', { items: [item({ dateSource: 'guess' })] }],
    ['a missing date source', { items: [item({ dateSource: undefined })] }],
    ['a date with source none', { items: [item({ dateSource: 'none' })] }],
    ['no date with a source', { items: [item({ takenAt: null, dateSource: 'exif' })] }],
    ['an offset that is not a real zone', { items: [item({ dateSource: 'exif', takenOffsetMinutes: 7 })] }],
    ['an offset beyond +14:00', { items: [item({ dateSource: 'exif', takenOffsetMinutes: 900 })] }],
    ['an offset on a date that is not exif', { items: [item({ dateSource: 'sidecar', takenOffsetMinutes: 60 })] }],
    ['a missing offset field', { items: [item({ takenOffsetMinutes: undefined })] }],
    ['a latitude without a longitude', { items: [item({ latitude: 1, longitude: null })] }],
    ['a latitude out of range', { items: [item({ latitude: 91, longitude: 0 })] }],
    ['a longitude that is not finite', { items: [item({ latitude: 0, longitude: Infinity })] }],
    ['a description that is too long', { items: [item({ description: 'x'.repeat(4001) })] }],
    ['an album that is too long', { items: [item({ album: 'x'.repeat(201) })] }],
    ['an empty file name', { items: [item({ fileName: '' })] }],
    ['a file name that is too long', { items: [item({ fileName: 'x'.repeat(256) })] }],
  ])('refuses %s and stores nothing', async (_name, over) => {
    const d = await db();
    const before = snapshot(d);
    expect(() => importPhotoItems(d, input(over))).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(snapshot(d)).toBe(before);
  });

  test('a failure in the middle of the items rolls the whole import back', async () => {
    const d = await db();
    const before = snapshot(d);
    // The second item passes validation but is a duplicate of nothing; make the database refuse it with a CHECK it enforces itself.
    d.exec('PRAGMA foreign_keys = ON');
    const bad = input({ blobs: [{ sha256: A, size: 3, mime: null }], items: [item(), item({ album: 'Other', fileName: 'b.jpg', description: 'ok' })] });
    d.exec('CREATE TRIGGER stop BEFORE INSERT ON photo_items WHEN NEW.album = \'Other\' BEGIN SELECT RAISE(ABORT, \'refused\'); END');
    expect(() => importPhotoItems(d, bad)).toThrow(/refused/);
    expect(snapshot(d)).toBe(before);
  });
});

describe('undoPhotoBatch and reads', () => {
  test('removes only that batch, keeps files other items use, and is idempotent', async () => {
    const d = await db();
    importPhotoItems(d, input());
    importPhotoItems(d, input({ batchId: B2, blobs: [{ sha256: A, size: 3, mime: null }, { sha256: B, size: 1, mime: null }], items: [item({ album: 'Other' }), item({ sha256: B, album: 'Other', fileName: 'b.jpg' })] }));
    expect(undoPhotoBatch(d, B2)).toEqual({ found: true, removedItems: 2, removedAssignments: 0, unreferencedBlobs: [B] });
    expect(d.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: A }]);
    expect(undoPhotoBatch(d, B2)).toEqual({ found: false, removedItems: 0, removedAssignments: 0, unreferencedBlobs: [] });
    expect(listPhotoItems(d, { limit: 10 }).map((i) => i.album)).toEqual(['Trip']);
  });

  test('listPhotoItems pages by id and clamps the limit; bad params are refused', async () => {
    const d = await db();
    importPhotoItems(d, input({ items: [item(), item({ album: 'B' }), item({ album: 'C' })] }));
    const first = listPhotoItems(d, { limit: 2 });
    expect(first.map((i) => i.album)).toEqual(['Trip', 'B']);
    expect(listPhotoItems(d, { afterId: first[1].id, limit: 2 }).map((i) => i.album)).toEqual(['C']);
    expect(listPhotoItems(d, { limit: 0 })).toHaveLength(1);
    expect(() => listPhotoItems(d, { limit: 'x' } as never)).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(() => listPhotoItems(d, { afterId: 1.5, limit: 1 })).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(() => listPhotoItems(d, null as never)).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });
});
