import { describe, expect, test } from 'vitest';
import { exifTiff, garbageValues, heic, hostileExif, jpeg, png } from '../../../scripts/photo-fixtures.mjs';
import { EXIF_PREFIX_BYTES, readExif } from './exif';
import { sniffMedia } from './sniff';

const read = (bytes: Uint8Array) => readExif(bytes, sniffMedia(bytes)!.exif);

describe('readExif (JPEG)', () => {
  test('DateTimeOriginal with OffsetTimeOriginal is a real UTC instant', () => {
    const info = read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00' })));
    expect(info).toEqual({ takenAt: '2019-07-01T08:00:00Z', zone: 'offset', offsetMinutes: 120, latitude: null, longitude: null });
  });

  test('a negative offset moves the other way and can cross midnight', () => {
    expect(read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:12:31 22:30:00', offsetTime: '-03:00' })))?.takenAt).toBe('2020-01-01T01:30:00Z');
  });

  test('without an offset the wall-clock digits are kept and marked local', () => {
    const info = read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00' })));
    expect(info).toMatchObject({ takenAt: '2019-07-02T11:00:00Z', zone: 'local' });
  });

  test('big-endian TIFF reads the same as little-endian', () => {
    const a = read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00', offsetTime: '+01:00', bigEndian: true })));
    const b = read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00', offsetTime: '+01:00' })));
    expect(a).toEqual(b);
    expect(a?.takenAt).toBe('2019-07-02T10:00:00Z');
  });

  test('an impossible offset is ignored, the date is kept as local', () => {
    expect(read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00', offsetTime: '+99:99' })))).toMatchObject({ takenAt: '2019-07-02T11:00:00Z', zone: 'local' });
  });

  test('offsets: +14:00, +05:45 and -09:30 are real; +14:59, +14:30 and odd minutes are damaged and keep the digits as local', () => {
    const at = (offsetTime: string) => read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00', offsetTime })));
    expect(at('+14:00')).toMatchObject({ takenAt: '2019-07-01T21:00:00Z', zone: 'offset', offsetMinutes: 840 });
    expect(at('+05:45')).toMatchObject({ takenAt: '2019-07-02T05:15:00Z', offsetMinutes: 345 });
    expect(at('-09:30')).toMatchObject({ takenAt: '2019-07-02T20:30:00Z', offsetMinutes: -570 });
    for (const bad of ['+14:59', '+14:30', '+02:17', '+15:00', '+00:60']) expect(at(bad)).toMatchObject({ takenAt: '2019-07-02T11:00:00Z', zone: 'local', offsetMinutes: null });
  });

  test('an unset camera clock (1970 epoch, 0000) is no date; 2000-01-01 is kept', () => {
    const at = (d: string) => read(jpeg(1, exifTiff({ dateTimeOriginal: d })));
    expect(at('1970:01:01 00:00:00')).toBeNull();
    expect(at('0000:00:00 00:00:00')).toBeNull();
    expect(at('2000:01:01 00:00:00')).toMatchObject({ takenAt: '2000-01-01T00:00:00Z' });
    expect(at('1970:01:01 00:00:01')).toMatchObject({ takenAt: '1970-01-01T00:00:01Z' });
  });

  describe('an Exif segment that starts inside the prefix but extends past it', () => {
    const tiff = exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00', gps: { lat: [38, 42, 0], lon: [9, 8, 0] } });
    /** SOI, APP2 padding, then the Exif APP1 starting `before` bytes ahead of the prefix boundary. */
    const file = (before: number) => {
      const exif = new Uint8Array(4 + 6 + tiff.length);
      exif.set([0xff, 0xe1, (exif.length - 2) >> 8, (exif.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
      exif.set(tiff, 10);
      let pad = EXIF_PREFIX_BYTES - before - 2;
      const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
      while (pad > 0) {
        const take = pad > 65_537 ? 65_537 : pad < 4 ? 4 : pad; // a segment is 4 bytes of header at least
        const segment = new Uint8Array(take);
        segment.set([0xff, 0xe2, (take - 2) >> 8, (take - 2) & 255]);
        parts.push(segment);
        pad -= take;
      }
      parts.push(exif, Uint8Array.of(0xff, 0xd9));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };

    test.each([20, 40, 70, 90, 110])('cut %s bytes after the segment start: no date and no place, never a wrong one', (before) => {
      const whole = file(before);
      const head = whole.subarray(0, EXIF_PREFIX_BYTES);
      expect(sniffMedia(head)?.exif).toBe('jpeg');
      const info = readExif(head, 'jpeg');
      expect(info?.takenAt ?? null).toBeNull();
      expect(info?.latitude ?? null).toBeNull();
    });

    test('the same file with the segment fully inside the prefix reads correctly', () => {
      const whole = file(tiff.length + 400);
      expect(readExif(whole.subarray(0, EXIF_PREFIX_BYTES), 'jpeg')).toMatchObject({ takenAt: '2019-07-01T08:00:00Z', zone: 'offset' });
    });
  });

  test('GPS: degrees, minutes, seconds with N/S and E/W', () => {
    const info = read(jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', gps: { lat: [38, 42, 5000], lon: [9, 8, 1000], latRef: 'S', lonRef: 'W' } })));
    expect(info!.latitude).toBeCloseTo(-38.7139, 3);
    expect(info!.longitude).toBeCloseTo(-9.1361, 3);
  });

  test('a place without a date is still returned', () => {
    const info = read(jpeg(1, exifTiff({ gps: { lat: [41, 23, 0], lon: [2, 10, 0] } })));
    expect(info).toMatchObject({ takenAt: null, zone: null });
    expect(info!.latitude).toBeCloseTo(41.3833, 3);
  });

  test('no Exif, or a PNG, is no metadata', () => {
    expect(read(jpeg(1))).toBeNull();
    expect(readExif(png(1), null)).toBeNull();
  });

  test.each(Object.entries(garbageValues()))('garbage value %s is dropped', (_name, bytes) => {
    const info = read(bytes);
    expect(info?.takenAt ?? null).toBeNull();
    expect(info?.latitude ?? null).toBeNull();
  });

  test.each(Object.entries(hostileExif()))('hostile Exif %s reads as no metadata and does not throw', (_name, bytes) => {
    expect(readExif(bytes, 'jpeg')).toBeNull();
  });

  test('random bytes and every prefix of a valid file never throw', () => {
    const valid = jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00', gps: { lat: [1, 2, 3], lon: [4, 5, 6] } }));
    for (let n = 0; n <= valid.length; n++) expect(() => readExif(valid.subarray(0, n), 'jpeg')).not.toThrow();
    let seed = 7;
    for (let round = 0; round < 200; round++) {
      const noisy = valid.slice();
      for (let k = 0; k < 6; k++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        noisy[seed % noisy.length] = seed & 255;
      }
      expect(() => readExif(noisy, 'jpeg')).not.toThrow();
    }
  });

  test('only the prefix is ever looked at', () => {
    expect(EXIF_PREFIX_BYTES).toBe(256 * 1024);
  });
});

describe('readExif (HEIC)', () => {
  test('finds the Exif item through iinf and iloc', () => {
    const file = heic(6, exifTiff({ dateTimeOriginal: '2019:07:04 12:30:00', offsetTime: '-03:00', gps: { lat: [10, 0, 0], lon: [20, 0, 0] } }));
    expect(sniffMedia(file)).toMatchObject({ mime: 'image/heic', exif: 'heif' });
    expect(read(file)).toMatchObject({ takenAt: '2019-07-04T15:30:00Z', zone: 'offset', latitude: 10, longitude: 20 });
  });

  test('a HEIC without Exif is no metadata', () => {
    expect(read(heic(6))).toBeNull();
  });

  test('truncated and corrupted HEIC never throw', () => {
    const valid = heic(6, exifTiff({ dateTimeOriginal: '2019:07:04 12:30:00' }));
    for (let n = 0; n <= valid.length; n += 3) expect(() => readExif(valid.subarray(0, n), 'heif')).not.toThrow();
    let seed = 11;
    for (let round = 0; round < 300; round++) {
      const noisy = valid.slice();
      for (let k = 0; k < 4; k++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        noisy[seed % 160] = seed & 255; // the boxes, not the filler
      }
      expect(() => readExif(noisy, 'heif')).not.toThrow();
    }
  });

  test('an Exif item that lies beyond the file is ignored', () => {
    const valid = heic(6, exifTiff({ dateTimeOriginal: '2019:07:04 12:30:00' }));
    expect(readExif(valid.subarray(0, valid.length - 200), 'heif')).toBeNull();
  });
});
