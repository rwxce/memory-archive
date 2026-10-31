import { describe, expect, test } from 'vitest';
import { takeoutZip } from '../../scripts/takeout-fixtures.mjs';
import { DbError } from '../db/errors';
import { PHOTO_DATES_PAGE_MAX } from '../db/photo-assign';
import { PHOTO_ASSIGN_MAX, type NewPhotoItem } from '../domain/photo';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import {
  assignPhotos,
  countPhotoPictures,
  listPhotoMonths,
  listPhotoPictures,
  listProfilePhotos,
  readPhotoFile,
  readPhotoTile,
  unassignPhotoLinks,
  unassignPhotos,
} from './photo-assign';
import { importTakeoutAlbum, undoPhotoImport } from './photo-library';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

const hash = (n: number) => n.toString(16).padStart(4, '0').repeat(16);
const NOW = '2026-03-01T10:00:00.000Z';
let batchNo = 100;

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
  album: '',
  fileName: `${n}.jpg`,
  ...over,
});

/** Items straight into the collection (no bytes in the store): for grouping and assignment logic. */
function addItems(lib: Lib, items: NewPhotoItem[]) {
  const blobs = [...new Set(items.map((i) => i.sha256))].map((sha256) => ({ sha256, size: 1, mime: null }));
  return lib.client.call('importPhotoItems', {
    batchId: `00000000-0000-4000-8000-${(++batchNo).toString(16).padStart(12, '0')}`,
    source: 'loose',
    sourceLabel: 'f',
    now: NOW,
    blobs,
    items,
  });
}

const twoProfiles = async (lib: Lib) => [(await createProfile(lib.deps, { displayName: 'Ana' })).id, (await createProfile(lib.deps, { displayName: 'Bru' })).id] as const;

describe('listPhotoMonths', () => {
  test('buckets by the one date rule: exif by the camera clock, exif-local as written, sidecar in the viewer zone; undated apart', async () => {
    const lib = await createTestLibrary();
    await addItems(lib, [
      // 23:30 UTC on 31 Jan; at +10:00 the photo was taken on 1 Feb.
      item(1, { dateSource: 'exif', takenAt: '2020-01-31T23:30:00Z', takenOffsetMinutes: 600 }),
      // Camera digits: 31 Jan 23:30 stays January whatever the viewer's zone.
      item(2, { dateSource: 'exif-local', takenAt: '2020-01-31T23:30:00Z' }),
      // A UTC instant: January in UTC, February for a viewer at +02:00.
      item(3, { dateSource: 'sidecar', takenAt: '2020-01-31T23:30:00Z' }),
      item(4, { dateSource: 'sidecar', takenAt: '2019-12-15T12:00:00Z' }),
      item(5, { dateSource: 'none', takenAt: null }),
    ]);
    expect(await listPhotoMonths(lib.deps)).toEqual({
      months: [
        { month: '2020-02', count: 1 },
        { month: '2020-01', count: 2 },
        { month: '2019-12', count: 1 },
      ],
      undated: 1,
    });
    expect(await listPhotoMonths(lib.deps, { zoneOffsetMinutes: () => 120 })).toEqual({
      months: [
        { month: '2020-02', count: 2 },
        { month: '2020-01', count: 1 },
        { month: '2019-12', count: 1 },
      ],
      undated: 1,
    });
  });

  test('a picture in two albums counts once, and the scope narrows it', async () => {
    const lib = await createTestLibrary();
    const [ana] = await twoProfiles(lib);
    await addItems(lib, [item(1, { album: 'A' }), item(1, { album: 'B' }), item(2, { takenAt: '2018-03-03T00:00:00Z' })]);
    await assignPhotos(lib.deps, { sha256s: [hash(2)], profileIds: [ana] });
    expect((await listPhotoMonths(lib.deps)).months).toEqual([{ month: '2019-07', count: 1 }, { month: '2018-03', count: 1 }]);
    expect((await listPhotoMonths(lib.deps, { scope: { show: 'unassigned' } })).months).toEqual([{ month: '2019-07', count: 1 }]);
    expect((await listPhotoMonths(lib.deps, { scope: { show: 'assigned', profileId: ana } })).months).toEqual([{ month: '2018-03', count: 1 }]);
  });

  test('more pictures than one page of dates are all counted', async () => {
    const lib = await createTestLibrary();
    const total = PHOTO_DATES_PAGE_MAX + 7;
    const items = Array.from({ length: total }, (_, i) => item(i + 1, { fileName: `${i}.jpg` }));
    for (let i = 0; i < items.length; i += 2500) await addItems(lib, items.slice(i, i + 2500));
    expect(await listPhotoMonths(lib.deps)).toEqual({ months: [{ month: '2019-07', count: total }], undated: 0 });
  });
});

describe('assigning through the use cases', () => {
  test('imported pictures start unassigned; assignment is explicit, shows per profile and counts for the UI', async () => {
    const lib = await createTestLibrary();
    const [ana, bru] = await twoProfiles(lib);
    await addItems(lib, [item(1, { takenAt: '2019-07-03T00:00:00Z' }), item(2, { takenAt: '2019-07-02T00:00:00Z' }), item(3, { takenAt: '2019-07-01T00:00:00Z' })]);
    expect(await countPhotoPictures(lib.deps)).toEqual({ pictures: 3, unassigned: 3, items: 3 });
    expect(await assignPhotos(lib.deps, { sha256s: [hash(1), hash(2)], profileIds: [ana] })).toEqual({ added: 2, alreadyThere: 0, fresh: [{ profileId: ana, sha256s: [hash(1), hash(2)] }] });
    expect(await assignPhotos(lib.deps, { sha256s: [hash(2)], profileIds: [ana, bru] })).toEqual({
      added: 1,
      alreadyThere: 1,
      fresh: [{ profileId: bru, sha256s: [hash(2)] }],
    });
    expect(await countPhotoPictures(lib.deps)).toEqual({ pictures: 3, unassigned: 1, items: 3 });
    expect((await listProfilePhotos(lib.deps, ana, { limit: 10 })).pictures.map((p) => p.sha256)).toEqual([hash(1), hash(2)]);
    expect((await listProfilePhotos(lib.deps, bru, { limit: 10 })).pictures.map((p) => p.sha256)).toEqual([hash(2)]);
    expect((await listPhotoPictures(lib.deps, { limit: 10, scope: { show: 'unassigned' } })).pictures.map((p) => p.sha256)).toEqual([hash(3)]);
    expect(await unassignPhotos(lib.deps, { sha256s: [hash(1), hash(3)], profileId: ana })).toEqual({ removed: 1 });
    expect((await countPhotoPictures(lib.deps)).unassigned).toBe(2);
  });

  test('undo takes back exactly the links one call added, even with another tab changing things', async () => {
    const lib = await createTestLibrary();
    const [ana, bru] = await twoProfiles(lib);
    await addItems(lib, [item(1), item(2), item(3)]);
    await assignPhotos(lib.deps, { sha256s: [hash(1)], profileIds: [ana] }); // an earlier call
    const mine = await assignPhotos(lib.deps, { sha256s: [hash(1), hash(2)], profileIds: [ana, bru] });
    expect(mine.fresh).toEqual([
      { profileId: ana, sha256s: [hash(2)] },
      { profileId: bru, sha256s: [hash(1), hash(2)] },
    ]);
    // Another tab already took one of them out and gave away a third picture: the undo touches neither.
    await unassignPhotos(lib.deps, { sha256s: [hash(2)], profileId: bru });
    await assignPhotos(lib.deps, { sha256s: [hash(3)], profileIds: [ana] });
    expect(await unassignPhotoLinks(lib.deps, mine.fresh!)).toEqual({ removed: 2 });
    const left = async (id: string) => (await listProfilePhotos(lib.deps, id, { limit: 10 })).pictures.map((p) => p.sha256);
    expect(await left(ana)).toEqual([hash(1), hash(3)]);
    expect(await left(bru)).toEqual([]);
    expect(await unassignPhotoLinks(lib.deps, mine.fresh!)).toEqual({ removed: 0 });
  });

  test('errors cross the worker boundary as DbErrors; a refused call changes nothing', async () => {
    const lib = await createTestLibrary();
    const [ana] = await twoProfiles(lib);
    await addItems(lib, [item(1)]);
    await expect(assignPhotos(lib.deps, { sha256s: [hash(1), hash(9)], profileIds: [ana] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(assignPhotos(lib.deps, { sha256s: [hash(1)], profileIds: ['00000000-0000-4000-8000-0000000000ff'] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(assignPhotos(lib.deps, { sha256s: [], profileIds: [ana] })).rejects.toBeInstanceOf(DbError);
    await expect(
      assignPhotos(lib.deps, { sha256s: Array.from({ length: PHOTO_ASSIGN_MAX + 1 }, (_, i) => hash(i + 1)), profileIds: [ana] }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await lib.client.call('countPhotoPictures')).toMatchObject({ unassigned: 1 });
  });

  test('undoing an import removes the assignments of pictures nothing else holds, reports them, keeps shared ones', async () => {
    const lib = await createTestLibrary();
    const [ana] = await twoProfiles(lib);
    const takeout = await importTakeoutAlbum(lib.deps, { zip: new Blob([takeoutZip() as BlobPart]), fileName: 't.zip' });
    const { pictures } = await listPhotoPictures(lib.deps, { limit: 100 });
    // The fixture has 15 items over 14 pictures (one picture in two albums).
    expect(pictures).toHaveLength(14);
    expect(pictures.filter((p) => p.itemCount === 2)).toHaveLength(1);
    await assignPhotos(lib.deps, { sha256s: pictures.map((p) => p.sha256), profileIds: [ana] });
    // A loose item over the same bytes as the first picture.
    await addItems(lib, [item(1, { sha256: pictures[0].sha256 })]);
    const undone = await undoPhotoImport(lib.deps, takeout.batchId!);
    expect(undone).toMatchObject({ found: true, removedItems: 15, removedAssignments: 13, removedMedia: 13 });
    const left = await listPhotoPictures(lib.deps, { limit: 100 });
    expect(left.pictures.map((p) => [p.sha256, p.assignedProfileIds])).toEqual([[pictures[0].sha256, [ana]]]);
    expect(await lib.client.call('findDanglingBlobRefs', { limit: 5 })).toEqual({ total: 0, items: [] });
    expect(lib.opened.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  test('a backup carries the assignments and a restored library keeps them (also from a library with others)', async () => {
    const lib = await createTestLibrary();
    const [ana] = await twoProfiles(lib);
    await importTakeoutAlbum(lib.deps, { zip: new Blob([takeoutZip() as BlobPart]), fileName: 't.zip' });
    const { pictures } = await listPhotoPictures(lib.deps, { limit: 100 });
    await assignPhotos(lib.deps, { sha256s: pictures.slice(0, 3).map((p) => p.sha256), profileIds: [ana] });
    const { blob } = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' });

    const restored = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: restored.opened.db, blobStore: restored.deps.blobStore }, blob);
    expect(await listPhotoPictures(restored.deps, { limit: 100 })).toEqual(await listPhotoPictures(lib.deps, { limit: 100 }));
    expect(await countPhotoPictures(restored.deps)).toEqual({ pictures: 14, unassigned: 11, items: 15 });
  });
});

describe('reading a picture', () => {
  async function withBytes() {
    const lib = await createTestLibrary();
    await importTakeoutAlbum(lib.deps, { zip: new Blob([takeoutZip() as BlobPart]), fileName: 't.zip' });
    const { pictures } = await listPhotoPictures(lib.deps, { limit: 100 });
    return { lib, pictures };
  }

  test('serves the stored file of a picture of the collection, typed from the picture', async () => {
    const { lib, pictures } = await withBytes();
    const jpeg = pictures.find((p) => p.mime === 'image/jpeg')!;
    const file = await readPhotoFile(lib.deps, jpeg.sha256);
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBeGreaterThan(0);
    // Not decodable here: the tile falls back to the file itself.
    expect((await readPhotoTile(lib.deps, jpeg.sha256))!.size).toBe(file.size);
  });

  test('a video has no tile image: the tile gets null and shows a placeholder', async () => {
    const lib = await createTestLibrary();
    await addItems(lib, [item(1, { kind: 'video', mime: 'video/mp4', fileName: 'a.mp4' })]);
    expect(await readPhotoTile(lib.deps, hash(1))).toBeNull();
  });

  test('a hash outside the collection is not readable through here, even when the store holds it', async () => {
    const { lib } = await withBytes();
    const info = await lib.deps.blobStore.put(new Blob([new Uint8Array([1, 2, 3])]).stream());
    await expect(readPhotoFile(lib.deps, info.sha256)).rejects.toMatchObject({ code: 'not-found' });
    await expect(readPhotoTile(lib.deps, info.sha256)).rejects.toMatchObject({ code: 'not-found' });
    await expect(readPhotoFile(lib.deps, 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  test('an item whose bytes are missing from the store is not-found', async () => {
    const lib = await createTestLibrary();
    await addItems(lib, [item(1)]);
    await expect(readPhotoFile(lib.deps, hash(1))).rejects.toMatchObject({ code: 'not-found' });
  });
});
