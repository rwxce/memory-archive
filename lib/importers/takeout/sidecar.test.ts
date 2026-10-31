import { describe, expect, test } from 'vitest';
import { MAX_SIDECAR_BYTES, epochToTakenAt, parseAlbumTitle, parseSidecar } from './sidecar';

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('epochToTakenAt', () => {
  test('turns epoch seconds (string or number) into a UTC instant', () => {
    expect(epochToTakenAt('1561975200')).toBe('2019-07-01T10:00:00Z');
    expect(epochToTakenAt(1561975200)).toBe('2019-07-01T10:00:00Z');
  });
  test.each([['0'], [0], [-5], ['-5'], ['1.5'], [1.5], ['abc'], [''], ['9999999999999'], [253_402_300_800], [null], [undefined], [{}], [NaN], [Infinity]])('refuses %j', (v) => {
    expect(epochToTakenAt(v)).toBeNull();
  });
});

describe('parseSidecar', () => {
  test('reads the fields we keep, ignoring people, url and upload time', () => {
    expect(
      parseSidecar(
        bytes({
          title: 'a.jpg',
          description: 'Hello',
          creationTime: { timestamp: '1700000000' },
          photoTakenTime: { timestamp: '1561975200' },
          geoData: { latitude: 41.39, longitude: 2.17 },
          people: [{ name: 'X' }],
          url: 'https://x.invalid',
        }),
      ),
    ).toEqual({ title: 'a.jpg', takenAt: '2019-07-01T10:00:00Z', latitude: 41.39, longitude: 2.17, description: 'Hello' });
  });

  test('a location of 0, 0 means none, and the camera location is the fallback', () => {
    expect(parseSidecar(bytes({ geoData: { latitude: 0, longitude: 0 } }))).toMatchObject({ latitude: null, longitude: null });
    expect(parseSidecar(bytes({ geoData: { latitude: 0, longitude: 0 }, geoDataExif: { latitude: 10, longitude: 20 } }))).toMatchObject({ latitude: 10, longitude: 20 });
  });

  test('a half or out-of-range location is dropped as a pair', () => {
    expect(parseSidecar(bytes({ geoData: { latitude: 10 } }))).toMatchObject({ latitude: null, longitude: null });
    expect(parseSidecar(bytes({ geoData: { latitude: 91, longitude: 0 } }))).toMatchObject({ latitude: null, longitude: null });
    expect(parseSidecar(bytes({ geoData: { latitude: 1, longitude: 181 } }))).toMatchObject({ latitude: null, longitude: null });
    expect(parseSidecar(bytes('{"geoData":{"latitude":1e999,"longitude":1}}'))).toMatchObject({ latitude: null });
  });

  test('wrong types become empty fields, never exceptions', () => {
    expect(parseSidecar(bytes({ title: 5, description: {}, photoTakenTime: 'x', geoData: 'x' }))).toEqual({ title: null, takenAt: null, latitude: null, longitude: null, description: '' });
  });

  test('keeps line breaks in a description, drops other control characters and bounds the length', () => {
    const d = parseSidecar(bytes({ description: `a\r\nb\u0000c${'x'.repeat(10_000)}` }))!.description;
    expect(d.startsWith('a\nb c')).toBe(true);
    expect(d.length).toBeLessThanOrEqual(4000);
  });

  test('not JSON, not UTF-8, not an object, too big: null', () => {
    expect(parseSidecar(bytes('{'))).toBeNull();
    expect(parseSidecar(bytes('[]'))).toBeNull();
    expect(parseSidecar(bytes('"x"'))).toBeNull();
    expect(parseSidecar(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseSidecar(new Uint8Array(MAX_SIDECAR_BYTES + 1).fill(32))).toBeNull();
  });

  test('a byte order mark is tolerated and a __proto__ key pollutes nothing', () => {
    expect(parseSidecar(bytes('\uFEFF{"__proto__":{"polluted":1},"title":"t"}'))?.title).toBe('t');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseAlbumTitle', () => {
  test('returns the cleaned title, or null', () => {
    expect(parseAlbumTitle(bytes({ title: '  Trip\u0000  ' }))).toBe('Trip');
    expect(parseAlbumTitle(bytes({ title: '   ' }))).toBeNull();
    expect(parseAlbumTitle(bytes({ title: 7 }))).toBeNull();
    expect(parseAlbumTitle(bytes('nope'))).toBeNull();
    expect(parseAlbumTitle(bytes({ title: 'x'.repeat(500) }))?.length).toBe(200);
  });
});

describe('limits count code points', () => {
  test('a description of 4000+ emoji is cut at 4000 code points, whole emoji only', () => {
    const meta = parseSidecar(new TextEncoder().encode(JSON.stringify({ title: 'a.jpg', description: '😀'.repeat(5000) })))!;
    expect(Array.from(meta.description)).toHaveLength(4000);
    expect(/\p{Cs}/u.test(meta.description)).toBe(false);
  });
  test('an emoji album title is cut at 200 code points', () => {
    const title = parseAlbumTitle(new TextEncoder().encode(JSON.stringify({ title: '🎉'.repeat(300) })))!;
    expect(Array.from(title)).toHaveLength(200);
  });
});
