import { describe, expect, test } from 'vitest';
import { PHOTO_ASSIGN_MAX, betterDate, type NewPhotoItem } from '../domain/photo';
import { DbError } from './errors';
import { openMemoryDb } from './open';
import { assignPhotos, countPhotoPictures, getPhotoPicture, listPhotoDates, listPhotoPictures, unassignPhotos } from './photo-assign';
import { importPhotoItems, undoPhotoBatch } from './photos';
import type { SqlDb } from './sql';

const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const batch = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-03-01T10:00:00.000Z';

const item = (n: number, over: Partial<NewPhotoItem> = {}): NewPhotoItem => ({
  sha256: hash(n),
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: '2019-07-01T10:00:00Z',
  takenOffsetMinutes: null,
  dateSource: 'sidecar',
  latitude: null,
  longitude: null,
  description: '',
  album: 'Trip',
  fileName: `${n}.jpg`,
  ...over,
});

let batchNo = 0;
function add(db: SqlDb, items: NewPhotoItem[], source = 'takeout') {
  const blobs = [...new Set(items.map((i) => i.sha256))].map((sha256) => ({ sha256, size: 1, mime: null }));
  return importPhotoItems(db, { batchId: batch(++batchNo), source, sourceLabel: 'f.zip', now: NOW, blobs, items });
}

async function db(): Promise<SqlDb> {
  const { db } = await openMemoryDb();
  for (const [id, name] of [[P1, 'Ana'], [P2, 'Bru']]) {
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, NOW, NOW]);
  }
  return db;
}

const page = (d: SqlDb, over: Record<string, unknown> = {}) => listPhotoPictures(d, { limit: 100, ...over } as never);
const hashes = (p: { pictures: { sha256: string }[] }) => p.pictures.map((x) => x.sha256);

describe('listPhotoPictures', () => {
  test('one row per picture: the same bytes in two albums and two sources are one tile', async () => {
    const d = await db();
    add(d, [item(1, { album: 'Trip' }), item(1, { album: 'Best of', takenAt: '2019-07-02T10:00:00Z' }), item(2)]);
    add(d, [item(1, { album: '', dateSource: 'file-modified', takenAt: '2020-01-01T00:00:00Z' })], 'loose');
    const { pictures } = page(d);
    expect(pictures).toHaveLength(2);
    expect(pictures.find((p) => p.sha256 === hash(1))).toMatchObject({
      albums: ['Best of', 'Trip'],
      albumCount: 2,
      sources: ['loose', 'takeout'],
      itemCount: 3,
      assignedProfileIds: [],
      // The best date: a sidecar beats the file-modified guess, and of two sidecars the earlier wins.
      dateSource: 'sidecar',
      takenAt: '2019-07-01T10:00:00Z',
    });
  });

  test('newest first by the wall clock of the photo, undated last, then by hash', async () => {
    const d = await db();
    add(d, [
      item(1, { takenAt: null, dateSource: 'none' }),
      item(2, { takenAt: '2019-07-01T10:00:00Z' }),
      item(3, { takenAt: '2021-01-01T00:00:00Z' }),
      item(4, { takenAt: null, dateSource: 'none' }),
      // 14:30 UTC on 30 June is 00:30 on 1 July at +10:00: it sorts by that wall clock, so after (older than) 10:00 on 1 July.
      item(5, { takenAt: '2019-06-30T14:30:00Z', dateSource: 'exif', takenOffsetMinutes: 600 }),
    ]);
    expect(hashes(page(d))).toEqual([hash(3), hash(2), hash(5), hash(1), hash(4)]);
  });

  test('pages by cursor without gaps or repeats, also across the undated tail and ties', async () => {
    const d = await db();
    const items: NewPhotoItem[] = [];
    for (let n = 1; n <= 23; n++) {
      items.push(item(n, n % 5 === 0 ? { takenAt: null, dateSource: 'none' } : { takenAt: `2019-07-0${(n % 3) + 1}T10:00:00Z` }));
    }
    add(d, items);
    const all: string[] = [];
    let cursor = null as never;
    for (let guard = 0; guard < 20; guard++) {
      const p = page(d, { limit: 4, cursor });
      all.push(...hashes(p));
      if (!p.nextCursor) break;
      cursor = p.nextCursor as never;
    }
    expect(all).toHaveLength(23);
    expect(new Set(all).size).toBe(23);
    expect(all).toEqual(hashes(page(d, { limit: 500 })));
  });

  test('a page ends exactly at the end without a dangling cursor', async () => {
    const d = await db();
    add(d, [item(1), item(2)]);
    expect(page(d, { limit: 2 }).nextCursor).toBeNull();
    expect(page(d, { limit: 1 }).nextCursor).not.toBeNull();
    expect(page(await db())).toEqual({ pictures: [], nextCursor: null });
  });

  test('assigning between pages never repeats a picture already past the cursor', async () => {
    const d = await db();
    add(d, [item(1, { takenAt: '2019-07-04T00:00:00Z' }), item(2, { takenAt: '2019-07-03T00:00:00Z' }), item(3, { takenAt: '2019-07-02T00:00:00Z' })]);
    const first = page(d, { limit: 1, scope: { show: 'unassigned' } });
    expect(hashes(first)).toEqual([hash(1)]);
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1], now: NOW });
    expect(hashes(page(d, { limit: 5, scope: { show: 'unassigned' }, cursor: first.nextCursor }))).toEqual([hash(2), hash(3)]);
  });

  test('scopes: unassigned, assigned (to anyone or to one profile) and all', async () => {
    const d = await db();
    add(d, [item(1), item(2), item(3)]);
    assignPhotos(d, { sha256s: [hash(1), hash(2)], profileIds: [P1], now: NOW });
    assignPhotos(d, { sha256s: [hash(2)], profileIds: [P2], now: NOW });
    expect(hashes(page(d, { scope: { show: 'unassigned' } }))).toEqual([hash(3)]);
    expect(hashes(page(d, { scope: { show: 'assigned' } })).sort()).toEqual([hash(1), hash(2)]);
    expect(hashes(page(d, { scope: { show: 'assigned', profileId: P2 } }))).toEqual([hash(2)]);
    expect(hashes(page(d, { scope: { show: 'all' } }))).toHaveLength(3);
    expect(page(d).pictures.find((p) => p.sha256 === hash(2))?.assignedProfileIds).toEqual([P1, P2]);
  });

  test('a picture assigned through one item is assigned for every item that holds it', async () => {
    const d = await db();
    add(d, [item(1, { album: 'A' }), item(1, { album: 'B' })]);
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1], now: NOW });
    expect(hashes(page(d, { scope: { show: 'unassigned' } }))).toEqual([]);
    expect(hashes(page(d, { scope: { show: 'assigned', profileId: P1 } }))).toEqual([hash(1)]);
  });

  test('the best item in SQL is the one betterDate picks, whatever order the items arrived in', async () => {
    const dates: Partial<NewPhotoItem>[] = [
      { dateSource: 'file-modified', takenAt: '2018-01-01T00:00:00Z' },
      { dateSource: 'exif-local', takenAt: '2019-01-01T08:00:00Z' },
      { dateSource: 'exif', takenAt: '2019-01-01T08:00:00Z', takenOffsetMinutes: 60 },
      { dateSource: 'exif', takenAt: '2019-01-01T08:00:00Z', takenOffsetMinutes: -60 },
      { dateSource: 'sidecar', takenAt: '2020-02-02T00:00:00Z' },
      { dateSource: 'sidecar', takenAt: '2020-02-01T00:00:00Z' },
      { dateSource: 'none', takenAt: null },
    ];
    for (let start = 0; start < dates.length; start++) {
      const d = await db();
      for (let i = 0; i < dates.length; i++) {
        const at = (i + start) % dates.length;
        add(d, [item(1, { ...dates[at], album: `a${at}`, fileName: `f${at}.jpg` })], `s${at}`);
      }
      // Reduce with the domain rule over every pair of the same candidates.
      const all = dates.map((o, at) => item(1, { ...o, album: `a${at}`, fileName: `f${at}.jpg` }));
      const expected = all.reduce((a, b) => betterDate(a, b));
      const got = page(d).pictures[0];
      expect([got.dateSource, got.takenAt, got.takenOffsetMinutes, got.fileName]).toEqual([expected.dateSource, expected.takenAt, expected.takenOffsetMinutes, expected.fileName]);
    }
  });

  test('albums are bounded to five names; albumCount has the real number', async () => {
    const d = await db();
    add(d, Array.from({ length: 8 }, (_, i) => item(1, { album: `Album ${i}` })));
    expect(page(d).pictures[0]).toMatchObject({ albums: ['Album 0', 'Album 1', 'Album 2', 'Album 3', 'Album 4'], albumCount: 8, itemCount: 8 });
  });

  test('rejects malformed input as invalid', async () => {
    const d = await db();
    const bad = (over: Record<string, unknown>) => expect(() => page(d, over)).toThrow(expect.objectContaining({ code: 'invalid' }));
    bad({ limit: 'x' });
    bad({ scope: { show: 'everything' } });
    bad({ scope: { show: 'unassigned', profileId: P1 } });
    bad({ scope: { show: 'assigned', profileId: 'nope' } });
    bad({ cursor: { sortKey: '2019', sha256: hash(1) } });
    bad({ cursor: { sortKey: null, sha256: 'x' } });
    expect(() => listPhotoPictures(d, null as never)).toThrow(DbError);
    // A limit out of range is clamped, not an error.
    expect(page(d, { limit: 0 }).pictures).toEqual([]);
  });
});

describe('getPhotoPicture and counts', () => {
  test('describes one picture or null; counts pictures, unassigned and items', async () => {
    const d = await db();
    add(d, [item(1, { album: 'A' }), item(1, { album: 'B' }), item(2)]);
    expect(getPhotoPicture(d, hash(1))).toMatchObject({ sha256: hash(1), itemCount: 2 });
    expect(getPhotoPicture(d, hash(9))).toBeNull();
    expect(() => getPhotoPicture(d, 'x')).toThrow(DbError);
    expect(countPhotoPictures(d)).toEqual({ pictures: 2, unassigned: 2, items: 3 });
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1, P2], now: NOW });
    expect(countPhotoPictures(d)).toEqual({ pictures: 2, unassigned: 1, items: 3 });
    expect(countPhotoPictures((await openMemoryDb()).db)).toEqual({ pictures: 0, unassigned: 0, items: 0 });
  });
});

describe('listPhotoDates', () => {
  test('one date row per picture, paged by hash', async () => {
    const d = await db();
    add(d, [item(1, { album: 'A' }), item(1, { album: 'B' }), item(2, { takenAt: null, dateSource: 'none' }), item(3)]);
    const first = listPhotoDates(d, { limit: 2 });
    expect(first.map((r) => r.sha256)).toEqual([hash(1), hash(2)]);
    expect(listPhotoDates(d, { limit: 2, afterSha256: hash(2) }).map((r) => r.sha256)).toEqual([hash(3)]);
    expect(first[1]).toEqual({ sha256: hash(2), takenAt: null, takenOffsetMinutes: null, dateSource: 'none' });
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1], now: NOW });
    expect(listPhotoDates(d, { limit: 10, scope: { show: 'unassigned' } }).map((r) => r.sha256)).toEqual([hash(2), hash(3)]);
    expect(() => listPhotoDates(d, { limit: 1, afterSha256: 'x' })).toThrow(DbError);
  });
});

describe('assignPhotos / unassignPhotos', () => {
  test('is explicit and idempotent: new links are counted, repeats change nothing and keep created_at', async () => {
    const d = await db();
    add(d, [item(1), item(2)]);
    expect(assignPhotos(d, { sha256s: [hash(1), hash(2)], profileIds: [P1], now: NOW })).toEqual({ added: 2, alreadyThere: 0 });
    expect(assignPhotos(d, { sha256s: [hash(2), hash(2), hash(1)], profileIds: [P1, P2], now: '2027-01-01T00:00:00.000Z' })).toEqual({ added: 2, alreadyThere: 2 });
    expect(d.all('SELECT created_at FROM photo_profiles WHERE profile_id = ? ORDER BY sha256', [P1])).toEqual([{ created_at: NOW }, { created_at: NOW }]);
  });

  test('nothing is assigned by importing: a fresh import leaves every picture unassigned', async () => {
    const d = await db();
    add(d, [item(1), item(2)]);
    expect(d.all('SELECT * FROM photo_profiles')).toEqual([]);
  });

  test('an unknown picture or profile is refused and nothing is written', async () => {
    const d = await db();
    add(d, [item(1)]);
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    expect(() => assignPhotos(d, { sha256s: [hash(1), hash(9)], profileIds: [P1], now: NOW })).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1, ghost], now: NOW })).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => unassignPhotos(d, { sha256s: [hash(1)], profileId: ghost })).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(d.all('SELECT * FROM photo_profiles')).toEqual([]);
  });

  test('a hash that is only a stored blob (a chat photo, a profile photo) is not a picture of the collection', async () => {
    const d = await db();
    d.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', [hash(7)]);
    expect(() => assignPhotos(d, { sha256s: [hash(7)], profileIds: [P1], now: NOW })).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  test('malformed and oversized input is invalid', async () => {
    const d = await db();
    add(d, [item(1)]);
    const bad = (input: unknown) => expect(() => assignPhotos(d, input as never)).toThrow(expect.objectContaining({ code: 'invalid' }));
    bad({ sha256s: [], profileIds: [P1], now: NOW });
    bad({ sha256s: [hash(1)], profileIds: [], now: NOW });
    bad({ sha256s: ['x'], profileIds: [P1], now: NOW });
    bad({ sha256s: [hash(1)], profileIds: ['x'], now: NOW });
    bad({ sha256s: [hash(1)], profileIds: [P1], now: '' });
    bad({ sha256s: 'all', profileIds: [P1], now: NOW });
    bad({ sha256s: Array.from({ length: PHOTO_ASSIGN_MAX + 1 }, (_, i) => hash(i % 200)).map((h, i) => `${h.slice(0, 60)}${i.toString(16).padStart(4, '0')}`), profileIds: [P1], now: NOW });
    bad({ sha256s: [hash(1)], profileIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`), now: NOW });
    expect(() => unassignPhotos(d, { sha256s: [hash(1)], profileId: 'x' })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(d.all('SELECT * FROM photo_profiles')).toEqual([]);
  });

  test('exactly the maximum is accepted', async () => {
    const d = await db();
    const items = Array.from({ length: PHOTO_ASSIGN_MAX }, (_, i) => item(1, { sha256: `${'0'.repeat(60)}${i.toString(16).padStart(4, '0')}`, fileName: `${i}.jpg` }));
    add(d, items);
    expect(assignPhotos(d, { sha256s: items.map((i) => i.sha256), profileIds: [P1], now: NOW })).toEqual({ added: PHOTO_ASSIGN_MAX, alreadyThere: 0 });
  });

  test('unassign removes only that profile\'s links, keeps the picture, and is idempotent', async () => {
    const d = await db();
    add(d, [item(1), item(2)]);
    assignPhotos(d, { sha256s: [hash(1), hash(2)], profileIds: [P1, P2], now: NOW });
    expect(unassignPhotos(d, { sha256s: [hash(1), hash(1), hash(9)], profileId: P1 })).toEqual({ removed: 1 });
    expect(unassignPhotos(d, { sha256s: [hash(1)], profileId: P1 })).toEqual({ removed: 0 });
    expect(d.all('SELECT sha256, profile_id FROM photo_profiles ORDER BY profile_id, sha256')).toEqual([
      { sha256: hash(2), profile_id: P1 },
      { sha256: hash(1), profile_id: P2 },
      { sha256: hash(2), profile_id: P2 },
    ]);
    expect(countPhotoPictures(d).items).toBe(2);
  });

  test('deleting a profile removes its links and nothing else', async () => {
    const d = await db();
    add(d, [item(1)]);
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1, P2], now: NOW });
    d.exec('PRAGMA foreign_keys = ON');
    d.run('DELETE FROM profiles WHERE id = ?', [P1]);
    expect(d.all('SELECT profile_id FROM photo_profiles')).toEqual([{ profile_id: P2 }]);
    expect(countPhotoPictures(d).items).toBe(1);
  });
});

describe('undoPhotoBatch and assignments', () => {
  test('a picture that loses its last item loses its assignments; one still held by another import keeps them', async () => {
    const d = await db();
    const a = add(d, [item(1), item(2)]).batchId!;
    add(d, [item(2, { album: 'Other' })], 'loose');
    assignPhotos(d, { sha256s: [hash(1), hash(2)], profileIds: [P1], now: NOW });
    const result = undoPhotoBatch(d, a);
    expect(result).toMatchObject({ found: true, removedItems: 2, removedAssignments: 1, unreferencedBlobs: [hash(1)] });
    expect(d.all('SELECT sha256 FROM photo_profiles')).toEqual([{ sha256: hash(2) }]);
    expect(d.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(undoPhotoBatch(d, a)).toMatchObject({ found: false, removedAssignments: 0 });
  });

  test('re-importing a picture after its import was undone starts unassigned', async () => {
    const d = await db();
    const a = add(d, [item(1)]).batchId!;
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1], now: NOW });
    undoPhotoBatch(d, a);
    add(d, [item(1)]);
    expect(page(d).pictures[0].assignedProfileIds).toEqual([]);
  });

  test('the blob of an assigned picture is kept while an item holds it', async () => {
    const d = await db();
    add(d, [item(1)]);
    assignPhotos(d, { sha256s: [hash(1)], profileIds: [P1], now: NOW });
    expect(add(d, [item(1)]).unreferencedBlobs).toEqual([]);
    expect(d.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: hash(1) }]);
  });
});
