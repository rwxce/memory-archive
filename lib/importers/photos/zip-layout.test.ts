import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { googlePhotosDownloadFiles, jpeg } from '../../../scripts/photo-fixtures.mjs';
import { takeoutZip } from '../../../scripts/takeout-fixtures.mjs';
import { TakeoutError } from '../takeout/paths';
import { isTakeoutLayout, looksLikeMediaDownload, readPhotoZipLayout } from './zip-layout';

const zipOf = (files: Record<string, Uint8Array>) => new Blob([zipSync(files, { level: 0 }) as BlobPart]);

describe('readPhotoZipLayout', () => {
  test('a flat download lists its media candidates in name order and counts what it ignores', async () => {
    const layout = await readPhotoZipLayout(zipOf(googlePhotosDownloadFiles()));
    if (layout.takeout) throw new Error('not a takeout');
    expect(layout.candidates.map((c) => c.fileName)).toEqual(['IMG_20190701_100000.jpg', 'IMG_20190702_110000.jpg', 'IMG_heic.heic', 'IMG_noexif.jpg', 'Screenshot_1.png', 'VID_20190703.mp4', 'fake.jpg', 'photo.mp4']);
    expect(layout.ignored).toBe(2); // notes.txt and the AppleDouble companion
    expect(layout.tooLarge).toBe(0);
  });

  test('a Takeout folder, or a metadata JSON beside the media, is a Takeout', async () => {
    expect((await readPhotoZipLayout(new Blob([takeoutZip() as BlobPart]))).takeout).toBe(true);
    expect((await readPhotoZipLayout(zipOf({ 'a.jpg': jpeg(1), 'a.jpg.json': new TextEncoder().encode('{}') }))).takeout).toBe(true);
    expect(isTakeoutLayout([{ name: 'Takeout/x', compression: 0, compressedSize: 0, uncompressedSize: 0, localHeaderOffset: 0, crc32: 0 }])).toBe(true);
  });

  test('pictures over the size limit are skipped and counted; files without an extension are candidates', async () => {
    const layout = await readPhotoZipLayout(zipOf({ big: new Uint8Array(500), small: jpeg(2) }), { maxMediaBytes: 400 });
    if (layout.takeout) throw new Error('not a takeout');
    expect(layout.candidates.map((c) => c.fileName)).toEqual(['small']);
    expect(layout.tooLarge).toBe(1);
  });

  test.each(['../evil.jpg', '/abs.jpg', 'C:/x.jpg', 'a/../b.jpg', 'a\\b.jpg', 'a//b.jpg', 'a/./b.jpg', 'bad\u0000.jpg'])('hostile name %j refuses the whole file', async (name) => {
    await expect(readPhotoZipLayout(zipOf({ [name]: jpeg(1), 'ok.jpg': jpeg(2) }))).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  test('a document or app package that embeds pictures is refused, not read as a download', async () => {
    const docx = { '[Content_Types].xml': new TextEncoder().encode('<T/>'), 'word/media/image1.png': jpeg(1) };
    await expect(readPhotoZipLayout(zipOf(docx))).rejects.toMatchObject({ code: 'invalid-takeout' });
    await expect(readPhotoZipLayout(zipOf({ mimetype: new TextEncoder().encode('application/epub+zip'), 'a.jpg': jpeg(1) }))).rejects.toMatchObject({ code: 'invalid-takeout' });
  });

  test('looksLikeMediaDownload: mostly pictures, companions ignored, package roots refused', () => {
    const e = (name: string) => ({ name, compression: 0, compressedSize: 0, uncompressedSize: 0, localHeaderOffset: 0, crc32: 0 });
    expect(looksLikeMediaDownload([e('a.jpg'), e('b.mp4'), e('t.html'), e('n.txt'), e('._a.jpg')], false)).toBe(true);
    expect(looksLikeMediaDownload([e('a.jpg'), e('x.c'), e('y.c')], false)).toBe(false);
    expect(looksLikeMediaDownload([e('a.jpg'), e('x.c'), e('y.c')], true)).toBe(true);
    expect(looksLikeMediaDownload([e('Takeout/a.jpg'), e('META-INF/MANIFEST.MF')], true)).toBe(false);
  });

  test('not a ZIP, and over the entry limit, are typed errors', async () => {
    await expect(readPhotoZipLayout(new Blob(['nope']))).rejects.toBeInstanceOf(TakeoutError);
    await expect(readPhotoZipLayout(zipOf({ 'a.jpg': jpeg(1), 'b.jpg': jpeg(2) }), { maxEntries: 1 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });
});
