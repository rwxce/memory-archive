import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { exifTiff, googlePhotosDownloadZip, heic, htmlDisguisedAsJpeg, jpeg, mp4, png } from '../../scripts/photo-fixtures.mjs';
import { takeoutZip } from '../../scripts/takeout-fixtures.mjs';
import { DbError } from '../db/errors';
import type { OpenedDb } from '../db/open';
import { sha256Hex } from '../domain/sha256';
import type { BlobStore } from '../storage/blob-store';
import { exportArchive, restoreArchiveIntoEmptyLibrary } from './archive';
import { photoDisplayDate } from '../domain/photo';
import { importGooglePhotosZip, importLoosePhotos, type PhotoFile } from './photo-import';
import { countPhotoItems, listPhotoBatches, listPhotoItems, undoPhotoImport } from './photo-library';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

const NOW = Date.parse('2026-03-01T10:00:00Z'); // the test library's clock
const MODIFIED = Date.parse('2020-05-05T05:05:05Z');
const file = (name: string, bytes: Uint8Array, lastModified = MODIFIED, type = ''): PhotoFile => new File([bytes as BlobPart], name, { lastModified, type });
const zipOf = (files: Record<string, Uint8Array>) => new Blob([zipSync(files, { level: 0 }) as BlobPart]);
const gpZip = () => new Blob([googlePhotosDownloadZip() as BlobPart]);

const rows = (opened: OpenedDb, table: string) => JSON.stringify(opened.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
const state = (opened: OpenedDb) => ['photo_items', 'photo_batches', 'blobs'].map((t) => rows(opened, t)).join('|');
const loose = (lib: Lib, files: PhotoFile[], extra: Partial<Parameters<typeof importLoosePhotos>[1]> = {}) => importLoosePhotos(lib.deps, { files, ...extra });
const gp = (lib: Lib, zip: Blob = gpZip(), extra: Partial<Parameters<typeof importGooglePhotosZip>[1]> = {}) =>
  importGooglePhotosZip(lib.deps, { zip, fileName: 'photos-1-001.zip', ...extra });

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

describe('importLoosePhotos', () => {
  test('stores the picked pictures; the date is EXIF when there is one, else the file time marked as a guess', async () => {
    const lib = await createTestLibrary();
    const result = await loose(lib, [
      file('with-offset.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00', gps: { lat: [38, 42, 0], lon: [9, 8, 0], lonRef: 'W' } }))),
      file('wall-clock.jpg', jpeg(2, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00' }))),
      file('no-exif.jpg', jpeg(3)),
      file('clip.mp4', mp4(4)),
      file('unset-time.png', png(5), 0),
    ]);
    expect(result.summary).toEqual({
      added: 5,
      alreadyThere: 0,
      duplicatesInFile: 0,
      mediaAdded: 5,
      withoutDate: 1, // the PNG whose last-modified time is unset
      dateGuessed: 2, // the JPEG without EXIF and the video
      unreadableFiles: 0,
      ignoredFiles: 0,
      unusableSidecars: 0,
      tooLarge: 0,
    });
    const items = await listPhotoItems(lib.deps, { limit: 100 });
    const by = (name: string) => items.find((i) => i.fileName === name)!;
    expect(by('with-offset.jpg')).toMatchObject({ takenAt: '2019-07-01T08:00:00Z', takenOffsetMinutes: 120, dateSource: 'exif', source: 'loose', album: '', kind: 'photo', mime: 'image/jpeg' });
    expect(by('with-offset.jpg').latitude).toBeCloseTo(38.7, 1);
    expect(by('with-offset.jpg').longitude).toBeCloseTo(-9.13, 1);
    expect(by('wall-clock.jpg')).toMatchObject({ takenAt: '2019-07-02T11:00:00Z', dateSource: 'exif-local' });
    expect(by('no-exif.jpg')).toMatchObject({ takenAt: '2020-05-05T05:05:05Z', dateSource: 'file-modified', latitude: null });
    expect(by('clip.mp4')).toMatchObject({ kind: 'video', mime: 'video/mp4', dateSource: 'file-modified' });
    expect(by('unset-time.png')).toMatchObject({ takenAt: null, dateSource: 'none' });
    // The collection belongs to the library: nothing is assigned to anybody.
    expect(lib.opened.db.all("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'photo_item_profiles'")).toEqual([{ n: 0 }]);
  });

  test('a file time in the future is not a date', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('future.jpg', jpeg(1), NOW + 30 * 86_400_000)]);
    expect((await listPhotoItems(lib.deps, { limit: 5 }))[0]).toMatchObject({ takenAt: null, dateSource: 'none' });
  });

  test('a HEIC picked from the gallery is read for its EXIF date', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('IMG_1.HEIC', heic(1, exifTiff({ dateTimeOriginal: '2019:07:04 12:30:00', offsetTime: '-03:00' })))]);
    expect((await listPhotoItems(lib.deps, { limit: 5 }))[0]).toMatchObject({ takenAt: '2019-07-04T15:30:00Z', dateSource: 'exif', mime: 'image/heic' });
  });

  test('the type comes from the bytes: a lying File.type, extension or content is not trusted', async () => {
    const lib = await createTestLibrary();
    const result = await loose(lib, [
      file('page.jpg', htmlDisguisedAsJpeg(), MODIFIED, 'image/jpeg'), // claims to be a picture, is a web page
      file('script.js', jpeg(1), MODIFIED, 'image/jpeg'), // picture bytes, not a picture name
      file('video.mp4', jpeg(2)), // a picture named like a video
      file('empty.jpg', new Uint8Array(0)),
      file('tiny.jpg', Uint8Array.of(0xff, 0xd8, 0xff)),
      file('really-a-png.jpg', png(3)),
      file('no-extension', jpeg(4)),
    ]);
    expect(result.summary).toMatchObject({ added: 2, ignoredFiles: 5 });
    const items = await listPhotoItems(lib.deps, { limit: 10 });
    expect(items.map((i) => [i.fileName, i.mime])).toEqual([
      ['really-a-png.jpg', 'image/png'],
      ['no-extension', 'image/jpeg'],
    ]);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
  });

  test('names are untrusted: only the cleaned base name is stored, and nothing becomes a path', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [
      file('../../etc/passwd.jpg', jpeg(1)),
      file('C:\\Users\\x\\sneaky\u0000\u001b[31m.jpg', jpeg(2)),
      file(`${'é'.repeat(400)}.jpg`, jpeg(3)),
      file('a.constructor', jpeg(4)),
      file('__proto__.jpg', jpeg(5)),
    ]);
    const names = (await listPhotoItems(lib.deps, { limit: 10 })).map((i) => i.fileName);
    expect(names).toHaveLength(4);
    expect(names[0]).toBe('passwd.jpg');
    expect(names[1]).toBe('sneaky  [31m.jpg'); // each control character became a space
    expect([...names[2]]).toHaveLength(255);
    expect(names[3]).toBe('__proto__.jpg');
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  test('a label groups the selection as an album (cleaned, NFC); no label means no album', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('a.jpg', jpeg(1))], { label: '  Cafe\u0301 \u0007trip  ' });
    await loose(lib, [file('b.jpg', jpeg(2))]);
    const items = await listPhotoItems(lib.deps, { limit: 10 });
    expect(items.map((i) => i.album)).toEqual(['Caf\u00e9  trip', '']);
    expect((await listPhotoBatches(lib.deps)).map((b) => b.sourceLabel).sort()).toEqual(['', 'Caf\u00e9  trip']);
  });

  test('importing the same files again adds nothing: no item, no batch, no file', async () => {
    const lib = await createTestLibrary();
    const files = () => [file('a.jpg', jpeg(1)), file('b.jpg', jpeg(2))];
    const first = await loose(lib, files());
    const before = state(lib.opened);
    const again = await importLoosePhotos({ ...lib.deps, newId: () => crypto.randomUUID() }, { files: files() });
    expect(again.batchId).toBeNull();
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 2, mediaAdded: 0 });
    expect(state(lib.opened)).toBe(before);
    expect(first.batchId).not.toBeNull();
  });

  test('an overlapping selection adds only what is new; renamed copies are the same picture', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('a.jpg', jpeg(1)), file('b.jpg', jpeg(2))]);
    const second = await importLoosePhotos({ ...lib.deps, newId: () => crypto.randomUUID() }, { files: [file('renamed.jpg', jpeg(1)), file('c.jpg', jpeg(3))] });
    expect(second.summary).toMatchObject({ added: 1, alreadyThere: 1, mediaAdded: 1 });
    expect(await countPhotoItems(lib.deps)).toBe(3);
  });

  test('the same bytes twice in one selection are one item that keeps the more trustworthy date', async () => {
    const lib = await createTestLibrary();
    const withExif = jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+00:00' }));
    // Same bytes cannot differ, so the two copies differ only in their file time: a guess either way.
    const result = await loose(lib, [file('a.jpg', withExif, MODIFIED), file('copy.jpg', withExif, MODIFIED + 1000)]);
    expect(result.summary).toMatchObject({ added: 1, duplicatesInFile: 1 });
    const none = jpeg(2);
    await loose(lib, [file('x.jpg', none, 0), file('y.jpg', none, MODIFIED)]);
    const x = (await listPhotoItems(lib.deps, { limit: 10 })).find((i) => i.fileName === 'x.jpg')!;
    expect(x).toMatchObject({ takenAt: '2020-05-05T05:05:05Z', dateSource: 'file-modified' }); // the dated copy wins over the undated one
  });

  test('the same bytes from another source are another item over the one stored file', async () => {
    const lib = await createTestLibrary();
    const bytes = jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00' }));
    const a = await loose(lib, [file('a.jpg', bytes)]);
    const b = await importGooglePhotosZip({ ...lib.deps, newId: () => crypto.randomUUID() }, { zip: zipOf({ 'x.jpg': bytes }), fileName: 'g.zip' });
    expect(b.summary).toMatchObject({ added: 1, alreadyThere: 0, mediaAdded: 0 });
    const items = await listPhotoItems(lib.deps, { limit: 10 });
    expect(items.map((i) => i.source)).toEqual(['loose', 'google-photos-zip']);
    expect(new Set(items.map((i) => i.sha256)).size).toBe(1);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    // Undoing one keeps the file for the other.
    expect(await undoPhotoImport(lib.deps, a.batchId!)).toMatchObject({ removedItems: 1, removedMedia: 0 });
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(await undoPhotoImport(lib.deps, b.batchId!)).toMatchObject({ removedItems: 1, removedMedia: 1 });
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('the whole file is stored (hash of every byte), though only the first 256 KiB are examined', async () => {
    const lib = await createTestLibrary();
    const big = new Uint8Array(900 * 1024 + 17).fill(7);
    big.set(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+00:00' })), 0);
    await loose(lib, [file('big.jpg', big)]);
    const [item] = await listPhotoItems(lib.deps, { limit: 5 });
    expect(item.sha256).toBe(sha256Hex(big));
    expect(item.dateSource).toBe('exif');
    expect(await lib.deps.blobStore.size(item.sha256)).toBe(big.length);
  });

  test('an empty selection adds nothing and leaves nothing', async () => {
    const lib = await createTestLibrary();
    expect(await loose(lib, [])).toMatchObject({ batchId: null, summary: { added: 0 } });
    expect(await listPhotoBatches(lib.deps)).toEqual([]);
  });

  test('limits: too many files, a file over the size limit (skipped, counted), the total', async () => {
    const lib = await createTestLibrary();
    await expect(loose(lib, [file('a.jpg', jpeg(1)), file('b.jpg', jpeg(2))], { limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    const skipped = await loose(lib, [file('small.jpg', jpeg(1)), file('big.jpg', new Uint8Array(500))], { limits: { maxMediaBytes: 400 } });
    expect(skipped.summary).toMatchObject({ added: 1, tooLarge: 1 });
    await expect(loose(lib, [file('c.jpg', jpeg(3)), file('d.jpg', jpeg(4))], { limits: { maxTotalBytes: jpeg(3).length } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await countPhotoItems(lib.deps)).toBe(1);
  });

  test('undo removes the items and the files only that import brought', async () => {
    const lib = await createTestLibrary();
    const result = await loose(lib, [file('a.jpg', jpeg(1)), file('b.jpg', jpeg(2))]);
    expect(await undoPhotoImport(lib.deps, result.batchId!)).toEqual({ found: true, removedItems: 2, removedMedia: 2 });
    expect(await countPhotoItems(lib.deps)).toBe(0);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await undoPhotoImport(lib.deps, result.batchId!)).toMatchObject({ found: false });
  });

  test('a backup carries the dates and sources; the restored library re-imports nothing', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('a.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00' }))), file('b.jpg', jpeg(2))], { label: 'Pick' });
    await gp(lib);
    const { blob } = await exportArchive({ db: lib.opened.db, blobStore: lib.deps.blobStore }, { appVersion: '1' });
    const restored = await createTestLibrary();
    await restoreArchiveIntoEmptyLibrary({ db: restored.opened.db, blobStore: restored.deps.blobStore }, blob);
    const items = await listPhotoItems(restored.deps, { limit: 100 });
    expect(items).toEqual(await listPhotoItems(lib.deps, { limit: 100 }));
    expect(new Set(items.map((i) => i.dateSource))).toEqual(new Set(['exif-local', 'file-modified', 'exif', 'none']));
    const again = await importLoosePhotos({ ...restored.deps, newId: () => crypto.randomUUID() }, { files: [file('a.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00' }))), file('b.jpg', jpeg(2))], label: 'Pick' });
    expect(again.batchId).toBeNull();
  });
});

describe('importLoosePhotos: interrupted and failing', () => {
  const files = () => [1, 2, 3, 4, 5].map((n) => file(`${n}.jpg`, jpeg(n)));

  test('abort between two files leaves the archive and the store as they were', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    const controller = new AbortController();
    await expect(
      loose(lib, files(), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('abort before anything starts', async () => {
    const lib = await createTestLibrary();
    const early = new AbortController();
    early.abort();
    await expect(loose(lib, files(), { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('the store failing half way removes what was written and touches no row', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    const deps = { ...lib.deps, blobStore: wrapStore(lib.deps.blobStore, (n) => { if (n === 4) throw new Error('disk full'); }) };
    await expect(importLoosePhotos(deps, { files: files() })).rejects.toThrow('disk full');
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a database that refuses the save rolls back; files stored before stay, this run is removed', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('0.jpg', jpeg(0))]);
    const stored = await lib.deps.blobStore.list();
    const before = state(lib.opened);
    const real = lib.client.call as (...a: unknown[]) => unknown;
    const client = { call: ((op: string, ...args: unknown[]) => (op === 'importPhotoItems' ? Promise.reject(new DbError('constraint', 'refused')) : real(op, ...args))) as typeof lib.client.call };
    await expect(importLoosePhotos({ ...lib.deps, client }, { files: files() })).rejects.toMatchObject({ code: 'constraint' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual(stored);
  });

  test('a second import at the same time is refused as busy', async () => {
    const lib = await createTestLibrary();
    const first = loose(lib, files());
    await expect(loose(lib, files())).rejects.toMatchObject({ code: 'busy' });
    await first;
  });

  test('progress reports reading, media (with bytes) and saving', async () => {
    const lib = await createTestLibrary();
    const phases: string[] = [];
    let last: { bytes?: number; totalBytes?: number } = {};
    await loose(lib, files(), { onProgress: (p) => { phases.push(p.phase); if (p.phase === 'media') last = p; } });
    expect(phases[0]).toBe('reading');
    expect(phases).toContain('saving');
    expect(last.bytes).toBe(last.totalBytes);
  });
});

describe('importLoosePhotos (unreadable files)', () => {
  const unreadable = (name: string, mode: 'open' | 'later'): PhotoFile => {
    const good = file(name, jpeg(9));
    return Object.assign(new Blob([jpeg(9) as BlobPart]), {
      name,
      lastModified: MODIFIED,
      stream: () =>
        mode === 'open'
          ? new ReadableStream<Uint8Array>({ pull: (c) => c.error(new DOMException('gone', 'NotReadableError')) })
          : good.stream(),
    }) as unknown as PhotoFile;
  };

  test('one unreadable file is skipped and counted; the rest of the selection is imported', async () => {
    const lib = await createTestLibrary();
    const result = await loose(lib, [file('a.jpg', jpeg(1)), unreadable('cloud-only.jpg', 'open'), file('b.jpg', jpeg(2))]);
    expect(result.summary).toMatchObject({ added: 2, unreadableFiles: 1, ignoredFiles: 0 });
    expect((await listPhotoItems(lib.deps, { limit: 10 })).map((i) => i.fileName).sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  test('a file that fails after its first bytes is skipped too, and leaves no stray media', async () => {
    const lib = await createTestLibrary();
    const head = jpeg(7).subarray(0, 20);
    const broken = Object.assign(new Blob([jpeg(7) as BlobPart]), {
      name: 'half.jpg',
      lastModified: MODIFIED,
      stream: () => {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent) c.error(new DOMException('changed', 'NotReadableError'));
            else {
              sent = true;
              c.enqueue(head);
            }
          },
        });
      },
    }) as unknown as PhotoFile;
    const result = await loose(lib, [broken, file('ok.jpg', jpeg(1))]);
    expect(result.summary).toMatchObject({ added: 1, unreadableFiles: 1 });
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
  });

  test('when every file is unreadable the import fails with a clear code and changes nothing', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    await expect(loose(lib, [unreadable('a.jpg', 'open'), unreadable('b.jpg', 'open')])).rejects.toMatchObject({ code: 'unreadable-files' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a +10:00 photo keeps its camera offset, so its local day survives', async () => {
    const lib = await createTestLibrary();
    await loose(lib, [file('night.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:05 00:30:00', offsetTime: '+10:00' })))]);
    const [item] = await listPhotoItems(lib.deps, { limit: 5 });
    expect(item).toMatchObject({ takenAt: '2019-07-04T14:30:00Z', takenOffsetMinutes: 600, dateSource: 'exif' });
    expect(photoDisplayDate(item)).toMatchObject({ day: '2019-07-05', time: '00:30' });
  });

  test('the same picture twice in one selection keeps one deterministic date, whatever the order', async () => {
    const a = file('a.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00' })));
    const b = file('a.jpg', jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00' })), MODIFIED);
    const seen: string[] = [];
    for (const order of [[a, b], [b, a]]) {
      const lib = await createTestLibrary();
      const result = await loose(lib, order);
      expect(result.summary.duplicatesInFile).toBe(1);
      seen.push(JSON.stringify((await listPhotoItems(lib.deps, { limit: 5 })).map(({ id: _id, batchId: _b, ...rest }) => rest)));
    }
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('importGooglePhotosZip', () => {
  test('a document that embeds pictures is refused, and the label of a real download is cleaned', async () => {
    const lib = await createTestLibrary();
    const docx = zipOf({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<doc/>'), 'word/media/image1.png': png(1) });
    await expect(gp(lib, docx)).rejects.toMatchObject({ code: 'invalid-takeout' });
    const result = await gp(lib, gpZip(), { fileName: 'photos\u0000-1.zip' });
    expect(result.batchId).not.toBeNull();
    const [batch] = await listPhotoBatches(lib.deps);
    expect(batch.sourceLabel).toBe('photos -1.zip');
  });

  test('imports a flat download: bytes decide what is a picture, EXIF gives the date, nothing is guessed', async () => {
    const lib = await createTestLibrary();
    const result = await gp(lib);
    expect(result.delegatedToTakeout).toBe(false);
    expect(result.summary).toEqual({
      added: 6,
      alreadyThere: 0,
      duplicatesInFile: 0,
      mediaAdded: 6,
      withoutDate: 3, // no EXIF: a ZIP entry's own time is not when it was taken
      dateGuessed: 0,
      unreadableFiles: 0,
      ignoredFiles: 4, // notes.txt, the AppleDouble companion, the page named .jpg and the picture named .mp4
      unusableSidecars: 0,
      tooLarge: 0,
    });
    const items = await listPhotoItems(lib.deps, { limit: 100 });
    const by = (name: string) => items.find((i) => i.fileName === name)!;
    expect(items.every((i) => i.source === 'google-photos-zip' && i.album === '')).toBe(true);
    expect(by('IMG_20190701_100000.jpg')).toMatchObject({ takenAt: '2019-07-01T08:00:00Z', dateSource: 'exif' });
    expect(by('IMG_20190701_100000.jpg').latitude).toBeCloseTo(38.7139, 3);
    expect(by('IMG_20190702_110000.jpg')).toMatchObject({ takenAt: '2019-07-02T11:00:00Z', dateSource: 'exif-local' });
    expect(by('IMG_heic.heic')).toMatchObject({ takenAt: '2019-07-04T15:30:00Z', dateSource: 'exif', mime: 'image/heic' });
    expect(by('Screenshot_1.png')).toMatchObject({ takenAt: null, dateSource: 'none', mime: 'image/png' });
    expect(by('VID_20190703.mp4')).toMatchObject({ kind: 'video', dateSource: 'none' });
    expect((await listPhotoBatches(lib.deps))[0]).toMatchObject({ source: 'google-photos-zip', sourceLabel: 'photos-1-001.zip', addedCount: 6 });
  });

  test('the same ZIP again adds nothing; undo takes the import back', async () => {
    const lib = await createTestLibrary();
    const first = await gp(lib);
    const before = state(lib.opened);
    const again = await importGooglePhotosZip({ ...lib.deps, newId: () => crypto.randomUUID() }, { zip: gpZip(), fileName: 'again.zip' });
    expect(again.batchId).toBeNull();
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 6, mediaAdded: 0 });
    expect(state(lib.opened)).toBe(before);
    expect(await undoPhotoImport(lib.deps, first.batchId!)).toMatchObject({ removedItems: 6, removedMedia: 6 });
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });

  test('a Takeout-shaped ZIP (folders or metadata files) goes to the Takeout importer', async () => {
    const lib = await createTestLibrary();
    const result = await gp(lib, new Blob([takeoutZip() as BlobPart]));
    expect(result.delegatedToTakeout).toBe(true);
    expect(result.summary).toMatchObject({ added: 15, dateGuessed: 0 });
    expect((await listPhotoItems(lib.deps, { limit: 100 })).every((i) => i.source === 'takeout')).toBe(true);

    const flatWithSidecar = await createTestLibrary();
    const sidecar = strToU8(JSON.stringify({ title: 'a.jpg', photoTakenTime: { timestamp: '1561975200' } }));
    const sidecarResult = await gp(flatWithSidecar, zipOf({ 'a.jpg': strToU8('FAKE-JPG-A'.repeat(4)), 'a.jpg.json': sidecar }));
    expect(sidecarResult.delegatedToTakeout).toBe(true);
    expect((await listPhotoItems(flatWithSidecar.deps, { limit: 5 }))[0]).toMatchObject({ source: 'takeout', dateSource: 'sidecar' });
  });

  test('no pictures in it, not a ZIP, a hostile entry name, a zip bomb', async () => {
    const lib = await createTestLibrary();
    await expect(gp(lib, zipOf({ 'readme.txt': strToU8('hello') }))).rejects.toMatchObject({ code: 'invalid-takeout' });
    await expect(gp(lib, new Blob(['not a zip']))).rejects.toMatchObject({ code: 'invalid-takeout' });
    await expect(gp(lib, zipOf({ '../escape.jpg': jpeg(1) }))).rejects.toMatchObject({ code: 'unsafe-path' });
    const bomb = new Blob([zipSync({ 'bomb.jpg': new Uint8Array(5_000_000) }) as BlobPart]); // deflated 5 MB of zeros
    await expect(gp(lib, bomb)).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await countPhotoItems(lib.deps)).toBe(0);
  });

  test('a ZIP entry that lies about its size is refused and cleaned up', async () => {
    const lib = await createTestLibrary();
    const bytes = new Uint8Array(await zipOf({ 'p.jpg': jpeg(1), 'q.jpg': jpeg(2) }).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let eocd = bytes.length - 22;
    while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const at = view.getUint32(eocd + 16, true);
    view.setUint32(at + 24, view.getUint32(at + 24, true) - 5, true);
    await expect(gp(lib, new Blob([bytes as BlobPart]))).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await countPhotoItems(lib.deps)).toBe(0);
  });

  test('abort between two files, and while reading, leave nothing behind', async () => {
    const lib = await createTestLibrary();
    const before = state(lib.opened);
    const controller = new AbortController();
    await expect(
      gp(lib, gpZip(), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 2) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(state(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    const reading = new AbortController();
    await expect(gp(lib, gpZip(), { signal: reading.signal, onProgress: (p) => { if (p.phase === 'reading' && p.done === 0) reading.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a second import at the same time is refused as busy', async () => {
    const lib = await createTestLibrary();
    const first = gp(lib);
    await expect(gp(lib)).rejects.toMatchObject({ code: 'busy' });
    await first;
  });
});
