import { describe, expect, test } from 'vitest';
import { gif, heic, htmlDisguisedAsJpeg, jpeg, mov, mp4, png, webp } from '../../../scripts/photo-fixtures.mjs';
import { acceptMedia, extensionVerdict, sniffMedia } from './sniff';

const text = (s: string) => new TextEncoder().encode(s.padEnd(32, ' '));

describe('sniffMedia', () => {
  test.each([
    ['jpeg', jpeg(1), 'photo', 'image/jpeg'],
    ['png', png(1), 'photo', 'image/png'],
    ['gif', gif(1), 'photo', 'image/gif'],
    ['webp', webp(1), 'photo', 'image/webp'],
    ['heic', heic(1), 'photo', 'image/heic'],
    ['mp4', mp4(1), 'video', 'video/mp4'],
    ['mov', mov(1), 'video', 'video/quicktime'],
  ])('%s', (_name, bytes, kind, mime) => {
    expect(sniffMedia(bytes)).toMatchObject({ kind, mime });
  });

  test('other formats by their magic bytes', () => {
    const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(40).fill(0)]);
    expect(sniffMedia(bytes(0x49, 0x49, 0x2a, 0))?.mime).toBe('image/tiff');
    expect(sniffMedia(bytes(0x1a, 0x45, 0xdf, 0xa3))?.mime).toBe('video/x-matroska');
    expect(sniffMedia(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d))?.mime).toBe('video/webm');
    expect(sniffMedia(bytes(0, 0, 1, 0xba))?.mime).toBe('video/mpeg');
    const avi = new TextEncoder().encode('RIFF\0\0\0\0AVI LIST____');
    expect(sniffMedia(avi)?.mime).toBe('video/x-msvideo');
    const avif = Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode('ftypavif'), ...new Array(16).fill(0)]);
    expect(sniffMedia(avif)).toMatchObject({ mime: 'image/avif', exif: null });
  });

  const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode(`ftyp${brand}`), ...new Array(16).fill(0)]);

  test.each([
    ['heif', 'image/heif'],
    ['avci', 'image/heif'],
    ['mif1', 'image/heif'],
    ['heic', 'image/heic'],
  ])('the %s brand is a HEIF photo whose Exif is read', (brand, mime) => {
    expect(sniffMedia(ftyp(brand))).toMatchObject({ kind: 'photo', mime, exif: 'heif' });
  });

  test.each(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'crx ', 'jp2 '])('the audio, RAW or other-image brand %j is not media', (brand) => {
    expect(sniffMedia(ftyp(brand))).toBeNull();
  });

  test('other ftyp brands stay MP4 video', () => {
    expect(sniffMedia(ftyp('isom'))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(sniffMedia(ftyp('mp42'))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
  });

  test('two letters are not a BMP', () => {
    expect(sniffMedia(text('BM is the start of many things'))).toBeNull();
  });

  test.each([
    ['html', htmlDisguisedAsJpeg()],
    ['text', text('just some text')],
    ['empty', new Uint8Array(0)],
    ['short', Uint8Array.of(0xff, 0xd8, 0xff)],
    ['a RIFF wave', new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ')],
    ['a pdf', text('%PDF-1.7')],
  ])('%s is not media', (_name, bytes) => {
    expect(sniffMedia(bytes)).toBeNull();
  });
});

describe('acceptMedia (bytes and name together)', () => {
  test('agreeing bytes and extension, or no extension, are kept', () => {
    expect(acceptMedia('a.jpg', jpeg(1))?.mime).toBe('image/jpeg');
    expect(acceptMedia('A.JPEG', jpeg(1))?.mime).toBe('image/jpeg');
    expect(acceptMedia('IMG_0001', jpeg(1))?.mime).toBe('image/jpeg');
    expect(acceptMedia('.jpg', jpeg(1))?.mime).toBe('image/jpeg');
  });

  test('the bytes decide the type: a .jpg holding a PNG is a PNG', () => {
    expect(acceptMedia('a.jpg', png(1))?.mime).toBe('image/png');
  });

  test('an extension that is not media, or names the other kind, refuses the file', () => {
    expect(acceptMedia('a.html', jpeg(1))).toBeNull();
    expect(acceptMedia('a.exe', jpeg(1))).toBeNull();
    expect(acceptMedia('a.', jpeg(1))).toBeNull();
    expect(acceptMedia('a.mp4', jpeg(1))).toBeNull();
    expect(acceptMedia('a.jpg', mp4(1))).toBeNull();
    expect(acceptMedia('a.constructor', jpeg(1))).toBeNull();
  });

  test('a picture name over web page bytes is refused', () => {
    expect(acceptMedia('fake.jpg', htmlDisguisedAsJpeg())).toBeNull();
  });
});

test('extensionVerdict', () => {
  expect(extensionVerdict('a.JPG')).toBe('photo');
  expect(extensionVerdict('a.mov')).toBe('video');
  expect(extensionVerdict('a.json')).toBe('other');
  expect(extensionVerdict('README')).toBe('none');
  expect(extensionVerdict('.jpg')).toBe('none');
});
