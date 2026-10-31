import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { LONG_NAME, TAKEN, fakeBytes, takeoutAlbumFiles, takeoutZip } from '../../../scripts/takeout-fixtures.mjs';
import { readTakeoutZip, type TakeoutItemPlan } from './read';
import { TakeoutError } from './paths';

const toBlob = (files: Record<string, Uint8Array>) => new Blob([zipSync(files, { level: 0 }) as BlobPart]);
const fixture = () => new Blob([takeoutZip() as BlobPart]);
const byName = (items: TakeoutItemPlan[], album: string, fileName: string) => {
  const found = items.find((i) => i.album === album && i.fileName === fileName);
  if (!found) throw new Error(`no ${album}/${fileName}`);
  return found;
};

const enc = (text: string) => new TextEncoder().encode(text);

describe('readTakeoutZip on the synthetic Takeout', () => {
  test('finds every picture and video, in the album the metadata names', async () => {
    const { items, stats } = await readTakeoutZip(fixture());
    expect(items.map((i) => `${i.album}/${i.fileName}`).sort()).toEqual(
      [
        `Family dinner/dinner-1.jpg`,
        `Family dinner/dinner-2.jpg`,
        `Trip to Lisbon/${LONG_NAME}`,
        'Trip to Lisbon/IMG_0001.jpg',
        'Trip to Lisbon/IMG_0002.jpg',
        'Trip to Lisbon/IMG_0004.jpg',
        'Trip to Lisbon/IMG_0005(1).jpg',
        'Trip to Lisbon/IMG_0005.jpg',
        'Trip to Lisbon/IMG_0006-edited.jpg',
        'Trip to Lisbon/IMG_0006.jpg',
        'Trip to Lisbon/IMG_0008.jpg',
        'Trip to Lisbon/IMG_0009.jpg',
        'Trip to Lisbon/IMG_0010.MP4',
        'Trip to Lisbon/IMG_0010.jpg',
        'Trip to Lisbon/VID_0007.mp4',
      ].sort(),
    );
    // archive_browser.html, notes.txt and IMG_0011.xyz are ignored; metadata.json files are not counted.
    expect(stats).toEqual({ ignored: 3, unusableSidecars: 0, tooLarge: 0 });
  });

  test('reads the original date, location and description from a classic sidecar', async () => {
    const { items } = await readTakeoutZip(fixture());
    const it = byName(items, 'Trip to Lisbon', 'IMG_0001.jpg');
    expect(it).toMatchObject({ kind: 'photo', mime: 'image/jpeg', metadataSource: 'sidecar' });
    expect(it.metadata).toEqual({ takenAt: TAKEN.lisbon1.iso, latitude: 38.7139, longitude: -9.1334, description: 'Sunset at the viewpoint' });
  });

  test('takes the camera location when the edited one is empty, and the new sidecar name', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'IMG_0002.jpg').metadata).toMatchObject({ takenAt: TAKEN.lisbon2.iso, latitude: 38.7, longitude: -9.2 });
  });

  test('matches a sidecar whose name was cut to 46 characters, for a long picture name and for a cut suffix', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', LONG_NAME).metadata?.takenAt).toBe(TAKEN.lisbon3.iso);
    expect(byName(items, 'Trip to Lisbon', 'IMG_0004.jpg').metadata?.takenAt).toBe(TAKEN.lisbon4.iso);
  });

  test('(1) duplicates each get their own sidecar', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'IMG_0005.jpg').metadata?.takenAt).toBe(TAKEN.lisbon5.iso);
    expect(byName(items, 'Trip to Lisbon', 'IMG_0005(1).jpg').metadata?.takenAt).toBe(TAKEN.lisbon6.iso);
  });

  test('an edited copy uses the sidecar of the original', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'IMG_0006-edited.jpg')).toMatchObject({ metadataSource: 'sidecar', metadata: { takenAt: TAKEN.lisbon6.iso } });
  });

  test('a video is a video', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'VID_0007.mp4')).toMatchObject({ kind: 'video', mime: 'video/mp4', metadata: { takenAt: TAKEN.lisbon7.iso } });
  });

  test('a picture without a sidecar is kept, with no date', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'IMG_0008.jpg')).toMatchObject({ metadata: null, metadataSource: 'none' });
  });

  test('a live photo video without a sidecar borrows its still image', async () => {
    const { items } = await readTakeoutZip(fixture());
    expect(byName(items, 'Trip to Lisbon', 'IMG_0010.MP4')).toMatchObject({ kind: 'video', metadataSource: 'live-photo', metadata: { takenAt: TAKEN.lisbon10.iso } });
  });

  test('a hostile sidecar is neutralised field by field and the picture is still kept', async () => {
    const { items } = await readTakeoutZip(fixture());
    const it = byName(items, 'Trip to Lisbon', 'IMG_0009.jpg');
    expect(it.fileName).toBe('IMG_0009.jpg'); // the title "../../etc/passwd" is never used
    expect(it.metadata).toEqual({ takenAt: null, latitude: null, longitude: null, description: 'line one  [31mred\nline two' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('readTakeoutZip matching safety', () => {
  const side = (title: string | null, taken = '1562000000') => enc(JSON.stringify({ title, photoTakenTime: { timestamp: taken } }));
  const A = 'Takeout/Google Photos/Album/';

  test('a (1) duplicate without a sidecar of its own does not take the original date', async () => {
    const { items } = await readTakeoutZip(toBlob({ [`${A}IMG_1.jpg`]: fakeBytes(1), [`${A}IMG_1(1).jpg`]: fakeBytes(2), [`${A}IMG_1.jpg.json`]: side('IMG_1.jpg') }));
    expect(byName(items, 'Album', 'IMG_1.jpg').metadataSource).toBe('sidecar');
    expect(byName(items, 'Album', 'IMG_1(1).jpg')).toMatchObject({ metadata: null, metadataSource: 'none' });
  });

  test('a picture whose only name-less candidate is claimed by another picture stays without metadata', async () => {
    const { items } = await readTakeoutZip(toBlob({ [`${A}a.jpg`]: fakeBytes(1), [`${A}a.jpg.json`]: side('a.jpg'), [`${A}b.jpg`]: fakeBytes(2) }));
    expect(byName(items, 'Album', 'b.jpg').metadata).toBeNull();
  });

  test('a unique exact title still rescues a picture whose sidecar has an odd name', async () => {
    const { items } = await readTakeoutZip(toBlob({ [`${A}a.jpg`]: fakeBytes(1), [`${A}odd-name.json`]: side('a.jpg') }));
    expect(byName(items, 'Album', 'a.jpg').metadataSource).toBe('sidecar');
  });

  test('a long name whose cut sidecar has no title is not accepted', async () => {
    const long = `${'a'.repeat(60)}.jpg`;
    const cut = `${(long + '.supplemental-metadata').slice(0, 46)}.json`;
    const { items } = await readTakeoutZip(toBlob({ [`${A}${long}`]: fakeBytes(1), [`${A}${cut}`]: side(null) }));
    expect(items[0].metadata).toBeNull();
  });

  test('a live photo borrows only inside its own folder', async () => {
    const { items } = await readTakeoutZip(
      toBlob({
        'Takeout/Google Photos/One/IMG_1.jpg': fakeBytes(1),
        'Takeout/Google Photos/One/IMG_1.jpg.json': side('IMG_1.jpg'),
        'Takeout/Google Photos/Two/IMG_1.MP4': fakeBytes(2),
        'Takeout/Google Photos/Two/other.jpg': fakeBytes(3),
        'Takeout/Google Photos/Two/other.jpg.json': side('other.jpg'),
      }),
    );
    expect(byName(items, 'Two', 'IMG_1.MP4')).toMatchObject({ metadata: null, metadataSource: 'none' });
  });

  test('a live photo does not borrow from a picture whose name differs in case', async () => {
    const { items } = await readTakeoutZip(toBlob({ [`${A}img_1.jpg`]: fakeBytes(1), [`${A}img_1.jpg.json`]: side('img_1.jpg'), [`${A}IMG_1.MP4`]: fakeBytes(2) }));
    expect(byName(items, 'Album', 'IMG_1.MP4').metadata).toBeNull();
  });
});

describe('readTakeoutZip layouts and limits', () => {
  test('a folder in a year folder or a file next to the service folder is in no album', async () => {
    const { items } = await readTakeoutZip(
      toBlob({
        'Takeout/Google Fotos/Photos from 2019/a.jpg': fakeBytes(1),
        'Takeout/Google Fotos/b.jpg': fakeBytes(2),
        'Takeout/Google Fotos/Viatge/c.jpg': fakeBytes(3),
      }),
    );
    expect(Object.fromEntries(items.map((i) => [i.fileName, i.album]))).toEqual({ 'a.jpg': '', 'b.jpg': '', 'c.jpg': 'Viatge' });
  });

  test('without a Takeout wrapper the folder is the album', async () => {
    const { items } = await readTakeoutZip(toBlob({ 'Holidays/a.jpg': fakeBytes(1) }));
    expect(items[0].album).toBe('Holidays');
  });

  test('the album metadata title wins over the folder name; a broken one falls back to the folder', async () => {
    const good = await readTakeoutZip(toBlob({ 'Takeout/Google Photos/Folder/a.jpg': fakeBytes(1), 'Takeout/Google Photos/Folder/metadata.json': enc('{"title":"Real title"}') }));
    expect(good.items[0].album).toBe('Real title');
    const bad = await readTakeoutZip(toBlob({ 'Takeout/Google Photos/Folder/a.jpg': fakeBytes(1), 'Takeout/Google Photos/Folder/metadata.json': enc('not json') }));
    expect(bad.items[0].album).toBe('Folder');
  });

  test('a name that would escape the archive refuses the whole file', async () => {
    for (const name of ['Takeout/../evil.jpg', '/abs/evil.jpg', 'C:/evil.jpg', 'a\\b.jpg', 'Takeout/./x.jpg', 'Takeout//x.jpg', 'Takeout/bad\u0007.jpg']) {
      await expect(readTakeoutZip(toBlob({ 'Takeout/ok.jpg': fakeBytes(1), [name]: fakeBytes(2) }))).rejects.toMatchObject({ code: 'unsafe-path' });
    }
  });

  test('oversized, unreadable or non-object sidecars are counted and do not stop the import', async () => {
    const big = enc(`{"title":"a.jpg","description":"${'x'.repeat(300 * 1024)}"}`);
    const { items, stats } = await readTakeoutZip(
      toBlob({
        'A/a.jpg': fakeBytes(1),
        'A/a.jpg.json': big,
        'A/b.jpg': fakeBytes(2),
        'A/b.jpg.json': enc('[1,2,3]'),
        'A/c.jpg': fakeBytes(3),
        'A/c.jpg.json': new Uint8Array([0xff, 0xfe, 0x00]),
      }),
    );
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.metadata === null)).toBe(true);
    expect(stats.unusableSidecars).toBe(3);
  });

  test('two long names sharing a 46-character prefix do not take each other\'s sidecar', async () => {
    const prefix = 'P'.repeat(50);
    const a = `${prefix}_a.jpg`;
    const b = `${prefix}_b.jpg`;
    const cutName = `${(a + '.supplemental-metadata').slice(0, 46)}.json`;
    const meta = (title: string, timestamp: string) => enc(JSON.stringify({ title, photoTakenTime: { timestamp } }));
    const { items } = await readTakeoutZip(toBlob({ [`F/${a}`]: fakeBytes(1), [`F/${b}`]: fakeBytes(2), [`F/${cutName}`]: meta(a, '1561975200') }));
    expect(items.find((i) => i.fileName === a)?.metadata?.takenAt).toBe('2019-07-01T10:00:00Z');
    expect(items.find((i) => i.fileName === b)?.metadata).toBeNull();
  });

  test('a unique title finds a sidecar whose name matches nothing', async () => {
    const { items } = await readTakeoutZip(toBlob({ 'F/a.jpg': fakeBytes(1), 'F/zzz.json': enc('{"title":"a.jpg","photoTakenTime":{"timestamp":"1561975200"}}') }));
    expect(items[0].metadata?.takenAt).toBe('2019-07-01T10:00:00Z');
  });

  test('refuses a file that is not a ZIP, one without pictures, and one over the limits', async () => {
    await expect(readTakeoutZip(new Blob(['nope']))).rejects.toMatchObject({ code: 'invalid-takeout' });
    await expect(readTakeoutZip(toBlob({ 'A/notes.txt': enc('x') }))).rejects.toBeInstanceOf(TakeoutError);
    await expect(readTakeoutZip(fixture(), { maxEntries: 5 })).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(readTakeoutZip(fixture(), { maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  test('a picture over the size limit is skipped and counted', async () => {
    const { items, stats } = await readTakeoutZip(toBlob({ 'A/a.jpg': fakeBytes(1), 'A/big.jpg': new Uint8Array(5000) }), { maxMediaBytes: 4000 });
    expect(items.map((i) => i.fileName)).toEqual(['a.jpg']);
    expect(stats.tooLarge).toBe(1);
  });

  test('the same input always gives the same plan', async () => {
    const a = await readTakeoutZip(fixture());
    const b = await readTakeoutZip(fixture());
    expect(a.items.map((i) => i.fileName)).toEqual(b.items.map((i) => i.fileName));
    expect(takeoutAlbumFiles()).toEqual(takeoutAlbumFiles());
  });
});
