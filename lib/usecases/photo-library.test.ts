import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { TAKEN, fakeBytes, takeoutAlbumFiles, takeoutZip } from '../../scripts/takeout-fixtures.mjs';
import { DbError } from '../db/errors';
import type { OpenedDb } from '../db/open';
import { isLibraryEmpty } from '../db/snapshot';
import { sha256Hex } from '../domain/sha256';
import type { BlobStore } from '../storage/blob-store';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { importWhatsAppExport, sweepOrphanBlobs } from './import';
import { countPhotoItems, importTakeoutAlbum, listPhotoBatches, listPhotoItems, undoPhotoImport } from './photo-library';
import { importPhotoItems } from '../db/photos';
import { webpBlob } from '../storage/test-thumbnail';
import { removeProfilePhoto, setProfilePhoto } from './profile-photo';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

const NAME = 'takeout-20260301.zip';
const fixtureZip = () => new Blob([takeoutZip() as BlobPart]);
const zipOf = (files: Record<string, Uint8Array>) => new Blob([zipSync(files, { level: 0 }) as BlobPart]);
/** The fixture restricted to the entries whose path contains one of `parts`. */
const only = (...parts: string[]) =>
  zipOf(Object.fromEntries(Object.entries(takeoutAlbumFiles()).filter(([path]) => parts.some((p) => path.includes(p)))));

const run = (lib: Lib, zip: Blob = fixtureZip(), extra: Partial<Parameters<typeof importTakeoutAlbum>[1]> = {}) =>
  importTakeoutAlbum(lib.deps, { zip, fileName: NAME, ...extra });

const rows = (opened: OpenedDb, table: string) => JSON.stringify(opened.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
const state = (opened: OpenedDb) =>
  ['photo_items', 'photo_batches', 'blobs', 'profiles', 'conversations', 'messages'].map((t) => rows(opened, t)).join('|');
const hashOf = (seed: number, kind = 'jpg') => sha256Hex(fakeBytes(seed, kind));

function wrapStore(real: BlobStore, put: (n: number) => void): BlobStore {
  let n = 0;
  return {
    put: async (source) => {
      put(++n);
      return real.put(source);
    },
    has: (s) => real.has(s),
    open: (s) => real.open(s),
    size: (s) => real.size(s),
    delete: (s) => real.delete(s),
    list: () => real.list(),
    verify: (s) => real.verify(s),
  };
}

describe('importTakeoutAlbum', () => {
  test('stores every picture and video as a library item, with the original date and place, assigned to nobody', async () => {
    const lib = await createTestLibrary();
    const result = await run(lib);
    expect(result.summary).toEqual({
      added: 15,
      alreadyThere: 0,
      duplicatesInFile: 0,
      mediaAdded: 14, // IMG_0001 and dinner-1 are the same bytes
      withoutDate: 2, // IMG_0008 has no sidecar, IMG_0009's is unusable
      ignoredFiles: 3,
      unusableSidecars: 0,
      tooLarge: 0,
    });
    expect(await countPhotoItems(lib.deps)).toBe(15);
    expect(await lib.deps.blobStore.list()).toHaveLength(14);

    const items = await listPhotoItems(lib.deps, { limit: 100 });
    const first = items.find((i) => i.fileName === 'IMG_0001.jpg')!;
    expect(first).toMatchObject({
      sha256: hashOf(1),
      kind: 'photo',
      mime: 'image/jpeg',
      takenAt: TAKEN.lisbon1.iso,
      dateSource: 'sidecar',
      latitude: 38.7139,
      longitude: -9.1334,
      description: 'Sunset at the viewpoint',
      source: 'takeout',
      album: 'Trip to Lisbon',
      batchId: result.batchId,
    });
    expect(items.find((i) => i.fileName === 'VID_0007.mp4')).toMatchObject({ kind: 'video', mime: 'video/mp4', sha256: hashOf(7, 'mp4') });
    // Nothing is attached to a person or a chat.
    expect(lib.opened.db.all('SELECT * FROM profiles')).toEqual([]);
    expect(lib.opened.db.all('SELECT * FROM conversations')).toEqual([]);
    expect(await listPhotoBatches(lib.deps)).toEqual([
      { id: result.batchId, source: 'takeout', sourceLabel: NAME, createdAt: '2026-03-01T10:00:00.000Z', addedCount: 15, skippedCount: 0 },
    ]);
  });

  test('the same picture in two albums is one stored file and two items', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    const items = (await listPhotoItems(lib.deps, { limit: 100 })).filter((i) => i.sha256 === hashOf(1));
    expect(items.map((i) => i.album).sort()).toEqual(['Family dinner', 'Trip to Lisbon']);
    expect(lib.opened.db.all('SELECT count(*) AS n FROM blobs WHERE sha256 = ?', [hashOf(1)])).toEqual([{ n: 1 }]);
  });

  test('the same ZIP again adds nothing: no item, no batch, no file', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    const before = state(lib.opened);
    const stored = await lib.deps.blobStore.list();
    const again = await run(lib);
    expect(again.batchId).toBeNull();
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 15, mediaAdded: 0 });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual(stored);
  });

  test('an overlapping ZIP adds only what is new', async () => {
    const lib = await createTestLibrary();
    await run(lib, only('Family dinner/dinner-1', 'Family dinner/metadata'));
    const overlap = await run(lib);
    expect(overlap.summary).toMatchObject({ added: 14, alreadyThere: 1 });
    expect(await countPhotoItems(lib.deps)).toBe(15);
    expect((await listPhotoBatches(lib.deps)).map((b) => b.addedCount).sort()).toEqual([1, 14]);
  });

  test('the same bytes twice in one album are stored once', async () => {
    const lib = await createTestLibrary();
    const zip = zipOf({ 'Takeout/Google Photos/A/x.jpg': fakeBytes(1), 'Takeout/Google Photos/A/copy of x.jpg': fakeBytes(1) });
    expect((await run(lib, zip)).summary).toMatchObject({ added: 1, duplicatesInFile: 1, mediaAdded: 1 });
  });

  test('a picture already stored by a chat import is reused, and undoing the photo import keeps it for the chat', async () => {
    const lib = await createTestLibrary();
    const profile = await createProfile(lib.deps, { displayName: 'Ana' });
    const attached = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
    const chat = zipSync({ '_chat.txt': strToU8(`[17/03/2026, 13:20:00] Ana: <attached: ${attached}>`), [attached]: fakeBytes(8) });
    await importWhatsAppExport(lib.deps, {
      zip: new Blob([chat as BlobPart]),
      fileName: 'WhatsApp Chat - Ana.zip',
      profileIds: [profile.id],
      meAuthor: 'Ana',
    });
    expect(await lib.deps.blobStore.list()).toEqual([hashOf(8)]);

    const result = await run(lib, only('IMG_0008'));
    expect(result.summary).toMatchObject({ added: 1, mediaAdded: 0 });
    const undone = await undoPhotoImport(lib.deps, result.batchId!);
    expect(undone).toEqual({ found: true, removedItems: 1, removedAssignments: 0, removedMedia: 0 });
    expect(await lib.deps.blobStore.list()).toEqual([hashOf(8)]);
  });
});

describe('importTakeoutAlbum: date source', () => {
  test('a date from a sidecar is sidecar, a picture without one is none, and the two always agree', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    const items = await listPhotoItems(lib.deps, { limit: 100 });
    expect(items.filter((i) => i.takenAt !== null).every((i) => i.dateSource === 'sidecar')).toBe(true);
    expect(items.filter((i) => i.takenAt === null).every((i) => i.dateSource === 'none')).toBe(true);
    expect(items.filter((i) => i.dateSource === 'none')).toHaveLength(2);
  });
});

describe('importTakeoutAlbum: awkward names and merged duplicates', () => {
  const T = 'Takeout/Google Photos/Album/';
  const side = (title: string, taken?: string, extra: object = {}) =>
    strToU8(JSON.stringify({ title, ...(taken ? { photoTakenTime: { timestamp: taken } } : {}), ...extra }));

  test('names such as a.constructor or toString are skipped, counted, and the import succeeds', async () => {
    const lib = await createTestLibrary();
    const zip = zipOf({
      [`${T}a.constructor`]: fakeBytes(1),
      [`${T}a.__proto__`]: fakeBytes(2),
      [`${T}toString`]: fakeBytes(3),
      [`${T}ok.jpg`]: fakeBytes(4),
    });
    const result = await run(lib, zip);
    expect(result.summary).toMatchObject({ added: 1, ignoredFiles: 3 });
    expect(await countPhotoItems(lib.deps)).toBe(1);
  });

  test('emoji-heavy album, file and description are cut by the importer and accepted by the database', async () => {
    const lib = await createTestLibrary();
    const e = '😀'.repeat(205);
    const f = `${'n'.repeat(300)}.jpg`;
    const zip = zipOf({
      [`Takeout/Google Photos/${e}/${f}`]: fakeBytes(1),
      [`Takeout/Google Photos/${e}/${f}.json`]: side(f, '1562000000', { description: '😀'.repeat(5000) }),
    });
    const result = await run(lib, zip, { fileName: `${'😀'.repeat(1200)}.zip` });
    expect(result.summary.added).toBe(1);
    const [it] = await listPhotoItems(lib.deps, { limit: 10 });
    expect(Array.from(it.album)).toHaveLength(200);
    expect(Array.from(it.fileName)).toHaveLength(255);
    expect(Array.from(it.description)).toHaveLength(4000);
    expect(/\p{Cs}/u.test((await listPhotoBatches(lib.deps))[0].sourceLabel)).toBe(false);
  });

  test('albums spelled with composed and decomposed letters are one album, and a re-import adds nothing', async () => {
    const lib = await createTestLibrary();
    const zip = zipOf({
      'Takeout/Google Photos/Caf\u00e9/a.jpg': fakeBytes(1),
      'Takeout/Google Photos/Cafe\u0301/a.jpg': fakeBytes(1),
    });
    const first = await run(lib, zip);
    expect(first.summary).toMatchObject({ added: 1, duplicatesInFile: 1 });
    expect((await listPhotoItems(lib.deps, { limit: 10 }))[0].album).toBe('Caf\u00e9');
    const nfd = zipOf({ 'Takeout/Google Photos/Cafe\u0301/a.jpg': fakeBytes(1) });
    expect((await run(lib, nfd)).summary).toMatchObject({ added: 0, alreadyThere: 1 });
  });

  test('the same bytes twice in one album keep the richer metadata whichever copy has it', async () => {
    const lib = await createTestLibrary();
    const zip = zipOf({
      [`${T}a.jpg`]: fakeBytes(1),
      [`${T}b.jpg`]: fakeBytes(1),
      [`${T}b.jpg.json`]: side('b.jpg', '1562000000', { description: 'kept', geoData: { latitude: 10, longitude: 20 } }),
    });
    expect((await run(lib, zip)).summary).toMatchObject({ added: 1, duplicatesInFile: 1, withoutDate: 0 });
    expect((await listPhotoItems(lib.deps, { limit: 10 }))[0]).toMatchObject({
      fileName: 'a.jpg',
      takenAt: '2019-07-01T16:53:20Z',
      latitude: 10,
      longitude: 20,
      description: 'kept',
    });
  });

  test('a file a photo item uses is kept when a profile photo that shares it is replaced or removed', async () => {
    const lib = await createTestLibrary();
    const profile = await createProfile(lib.deps, { displayName: 'Ana' });
    const down = async (image: Blob) => webpBlob(60, new Uint8Array(await image.arrayBuffer())[0] ?? 1);
    const pic = (fill: number) => new Blob([new Uint8Array(100).fill(fill)], { type: 'image/png' });
    const shared = await setProfilePhoto(lib.deps, profile.id, pic(1), down);
    // A photo item over the very same bytes.
    importPhotoItems(lib.opened.db, {
      batchId: '00000000-0000-4000-8000-000000000009',
      source: 'takeout',
      sourceLabel: 'x.zip',
      now: '2026-03-01T10:00:00.000Z',
      blobs: [{ sha256: shared.photoSha256!, size: 60, mime: 'image/webp' }],
      items: [{ sha256: shared.photoSha256!, kind: 'photo', mime: 'image/webp', takenAt: null, takenOffsetMinutes: null, dateSource: 'none', latitude: null, longitude: null, description: '', album: '', fileName: 'p.webp' }],
    });
    await setProfilePhoto(lib.deps, profile.id, pic(2), down);
    expect(await lib.deps.blobStore.has(shared.photoSha256!)).toBe(true);
    expect(lib.opened.db.all('SELECT 1 FROM blobs WHERE sha256 = ?', [shared.photoSha256])).toHaveLength(1);
    await removeProfilePhoto(lib.deps, profile.id);
    expect(await lib.deps.blobStore.has(shared.photoSha256!)).toBe(true);
  });
});

describe('undoPhotoImport', () => {
  test('removes the items and the files only it brought, and is safe to repeat', async () => {
    const lib = await createTestLibrary();
    const a = await run(lib, only('Family dinner/dinner-1', 'Family dinner/metadata'));
    const b = await run(lib);
    expect(await undoPhotoImport(lib.deps, b.batchId!)).toEqual({ found: true, removedItems: 14, removedAssignments: 0, removedMedia: 13 });
    // dinner-1 belongs to the first batch; its file (also IMG_0001's bytes) stays.
    expect((await listPhotoItems(lib.deps, { limit: 100 })).map((i) => i.fileName)).toEqual(['dinner-1.jpg']);
    expect(await lib.deps.blobStore.list()).toEqual([hashOf(1)]);
    expect(await undoPhotoImport(lib.deps, b.batchId!)).toEqual({ found: false, removedItems: 0, removedAssignments: 0, removedMedia: 0 });
    expect(await undoPhotoImport(lib.deps, a.batchId!)).toEqual({ found: true, removedItems: 1, removedAssignments: 0, removedMedia: 1 });
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await listPhotoBatches(lib.deps)).toEqual([]);
  });

  test('a malformed batch id is refused', async () => {
    const lib = await createTestLibrary();
    await expect(undoPhotoImport(lib.deps, 'nope')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('importTakeoutAlbum: interrupted and failing', () => {
  test('abort between two files leaves the archive and the store as they were', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    const controller = new AbortController();
    const attempt = run(lib, fixtureZip(), {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'media' && p.done === 3) controller.abort();
      },
    });
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('abort before anything starts, and during reading', async () => {
    const lib = await createTestLibrary();
    const early = new AbortController();
    early.abort();
    await expect(run(lib, fixtureZip(), { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const reading = new AbortController();
    await expect(
      run(lib, fixtureZip(), {
        signal: reading.signal,
        onProgress: (p) => {
          if (p.phase === 'reading' && p.done === 0) reading.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the store failing half way removes what was written and touches no row', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    const deps = {
      ...lib.deps,
      blobStore: wrapStore(lib.deps.blobStore, (n) => {
        if (n === 5) throw new Error('disk full');
      }),
    };
    await expect(importTakeoutAlbum(deps, { zip: fixtureZip(), fileName: NAME })).rejects.toThrow('disk full');
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a database that refuses the save rolls back and the new files are removed, but files stored before stay', async () => {
    const lib = await createTestLibrary();
    await run(lib, only('IMG_0008'));
    const stored = await lib.deps.blobStore.list();
    const before = state(lib.opened);
    const real = lib.client.call as (...a: unknown[]) => unknown;
    const client = {
      call: ((op: string, ...args: unknown[]) =>
        op === 'importPhotoItems' ? Promise.reject(new DbError('constraint', 'refused')) : real(op, ...args)) as typeof lib.client.call,
    };
    await expect(importTakeoutAlbum({ ...lib.deps, client }, { zip: fixtureZip(), fileName: NAME })).rejects.toMatchObject({ code: 'constraint' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual(stored);
  });

  test('a second import at the same time is refused as busy', async () => {
    const lib = await createTestLibrary();
    const first = run(lib);
    await expect(run(lib)).rejects.toMatchObject({ code: 'busy' });
    await first;
  });
});

describe('importTakeoutAlbum: hostile and unusable files', () => {
  test.each([
    ['a path that climbs out', { 'Takeout/../evil.jpg': fakeBytes(1), 'Takeout/ok.jpg': fakeBytes(2) }, 'unsafe-path'],
    ['an absolute path', { '/etc/evil.jpg': fakeBytes(1) }, 'unsafe-path'],
    ['a ZIP with no pictures', { 'Takeout/notes.txt': fakeBytes(1) }, 'invalid-takeout'],
  ])('%s leaves nothing behind', async (_name, files, code) => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    await expect(run(lib, zipOf(files))).rejects.toMatchObject({ code });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('not a ZIP', async () => {
    const lib = await createTestLibrary();
    await expect(run(lib, new Blob(['hello']))).rejects.toMatchObject({ code: 'invalid-takeout' });
  });

  test('limits: too many entries, total size and an oversized picture', async () => {
    const lib = await createTestLibrary();
    await expect(run(lib, fixtureZip(), { limits: { maxEntries: 3 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(run(lib, fixtureZip(), { limits: { maxTotalBytes: 100 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    const big = await run(lib, zipOf({ 'A/small.jpg': fakeBytes(1), 'A/big.jpg': new Uint8Array(5000) }), { limits: { maxMediaBytes: 4000 } });
    expect(big.summary).toMatchObject({ added: 1, tooLarge: 1 });
  });

  test('a sidecar that cannot be read is counted, the picture is kept without a date', async () => {
    const lib = await createTestLibrary();
    const result = await run(lib, zipOf({ 'A/p.jpg': fakeBytes(1), 'A/p.jpg.json': strToU8('{broken') }));
    expect(result.summary).toMatchObject({ added: 1, unusableSidecars: 1, withoutDate: 1 });
  });

  test('a ZIP entry that lies about its size is refused and cleaned up', async () => {
    const lib = await createTestLibrary();
    const bytes = new Uint8Array(await zipOf({ 'A/p.jpg': fakeBytes(1) }).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let eocd = bytes.length - 22;
    while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const at = view.getUint32(eocd + 16, true);
    view.setUint32(at + 24, view.getUint32(at + 24, true) - 5, true); // declares 5 bytes fewer than it holds
    await expect(run(lib, new Blob([bytes as BlobPart]))).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await countPhotoItems(lib.deps)).toBe(0);
  });
});

describe('the photo collection and the rest of the archive', () => {
  test('a library with photos is not empty, and is empty again after undoing the import', async () => {
    const lib = await createTestLibrary();
    expect(isLibraryEmpty(lib.opened.db)).toBe(true);
    const result = await run(lib);
    expect(isLibraryEmpty(lib.opened.db)).toBe(false);
    await undoPhotoImport(lib.deps, result.batchId!);
    expect(isLibraryEmpty(lib.opened.db)).toBe(true);
  });

  test('the orphan sweep keeps the files of photo items and removes strays', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    const stray = await lib.deps.blobStore.put(fakeBytes(999));
    expect(await sweepOrphanBlobs(lib.deps)).toEqual({ removed: 1 });
    expect(await lib.deps.blobStore.has(stray.sha256)).toBe(false);
    expect(await lib.deps.blobStore.list()).toHaveLength(14);
  });

  test('photo files count as photos and videos in the storage breakdown', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    const breakdown = await lib.client.call('getStorageBreakdown');
    expect(breakdown.photosVideosBytes).toBeGreaterThan(0);
    expect(breakdown.otherMediaBytes).toBe(0);
  });

  test('a backup carries the collection and its files; the restored library re-imports nothing and can undo', async () => {
    const lib = await createTestLibrary();
    const first = await run(lib);
    const { blob } = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' });

    const restored = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: restored.opened.db, blobStore: restored.deps.blobStore }, blob);
    expect(await listPhotoItems(restored.deps, { limit: 100 })).toEqual(await listPhotoItems(lib.deps, { limit: 100 }));
    expect(await listPhotoBatches(restored.deps)).toEqual(await listPhotoBatches(lib.deps));
    expect(await restored.deps.blobStore.list()).toEqual(await lib.deps.blobStore.list());

    // The test library hands out counting ids that would collide with the restored batch's; real ones are random.
    const again = await run({ ...restored, deps: { ...restored.deps, newId: () => crypto.randomUUID() } });
    expect(again.batchId).toBeNull();
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 15 });
    expect(await undoPhotoImport(restored.deps, first.batchId!)).toMatchObject({ found: true, removedItems: 15, removedMedia: 14 });
  });

  test('the health queries see the files of photo items', async () => {
    const lib = await createTestLibrary();
    await run(lib);
    expect(await lib.client.call('findDanglingBlobRefs', { limit: 10 })).toEqual({ total: 0, items: [] });
    const paged = (await lib.client.call('listBlobPage', { limit: 100 })).map((b) => b.sha256);
    expect(paged).toEqual(await lib.deps.blobStore.list());
  });
});
