import { describe, expect, test } from 'vitest';
import { albumFolderOf, checkTakeoutPath, classifyEntry, cleanText, displayFileName, mediaTypeOf, splitPath, TakeoutError } from './paths';

describe('checkTakeoutPath', () => {
  test('accepts real Takeout names: spaces, accents, folder entries', () => {
    for (const name of ['Takeout/Google Photos/Viatge a Lisboa/IMG 1 (1).jpg', 'Takeout/', 'a.jpg', 'Fotos/año/ç.jpg']) expect(() => checkTakeoutPath(name)).not.toThrow();
  });
  test.each([[''], ['/a'], ['a/../b'], ['..'], ['./a'], ['a//b'], ['C:/a'], ['c:a'], ['a\\b'], ['a\u0000b'], ['a\nb'], ['a\u2028b'], ['x'.repeat(1025)]])('refuses %j', (name) => {
    expect(() => checkTakeoutPath(name)).toThrowError(expect.objectContaining({ code: 'unsafe-path' }));
    expect(() => checkTakeoutPath(name)).toThrow(TakeoutError);
  });
});

describe('classification', () => {
  test('pictures, videos, album metadata, sidecars, the rest', () => {
    expect(classifyEntry('a.JPG')).toEqual({ type: 'media', kind: 'photo', mime: 'image/jpeg' });
    expect(classifyEntry('a.heic')).toMatchObject({ kind: 'photo' });
    expect(classifyEntry('a.MP4')).toEqual({ type: 'media', kind: 'video', mime: 'video/mp4' });
    expect(classifyEntry('metadata.json')).toEqual({ type: 'album-metadata' });
    expect(classifyEntry('a.jpg.json')).toEqual({ type: 'sidecar' });
    expect(classifyEntry('a.jpg.supplemental-metadata.json')).toEqual({ type: 'sidecar' });
    expect(classifyEntry('notes.txt')).toEqual({ type: 'ignored' });
    expect(classifyEntry('.jpg')).toEqual({ type: 'ignored' });
    expect(mediaTypeOf('noext')).toBeNull();
  });
});

describe('names that are also properties of every object', () => {
  test.each(['a.constructor', 'a.__proto__', 'a.toString', 'a.hasOwnProperty', 'constructor', 'a.valueOf'])('%s is not a picture', (name) => {
    expect(mediaTypeOf(name)).toBeNull();
    expect(classifyEntry(name)).toEqual({ type: 'ignored' });
  });
});

describe('cleanText', () => {
  test('cuts at code points and never inside an emoji', () => {
    const out = cleanText('😀'.repeat(300), 200);
    expect(Array.from(out)).toHaveLength(200);
    expect(out).toBe('😀'.repeat(200));
    expect(/\p{Cs}/u.test(out)).toBe(false);
  });
  test('replaces a lone surrogate', () => {
    expect(/\p{Cs}/u.test(cleanText('a\ud800b', 10))).toBe(false);
  });
  test('NFC and NFD are the same text; case is kept', () => {
    expect(cleanText('Cafe\u0301 Ni\u00f1o', 50)).toBe(cleanText('Caf\u00e9 Nin\u0303o', 50));
    expect(cleanText('Caf\u00e9 Ni\u00f1o', 50)).toBe('Caf\u00e9 Ni\u00f1o');
  });
});

describe('albumFolderOf', () => {
  test('album under the service folder, year folders and the service folder itself are no album', () => {
    expect(albumFolderOf(['Takeout', 'Google Photos', 'Trip']).name).toBe('Trip');
    expect(albumFolderOf(['Takeout', 'Google Photos', 'Photos from 2019']).name).toBe('');
    expect(albumFolderOf(['Takeout', 'Google Photos']).name).toBe('');
    expect(albumFolderOf(['Takeout']).name).toBe('');
    expect(albumFolderOf([]).name).toBe('');
    expect(albumFolderOf(['Trip']).name).toBe('Trip');
    expect(albumFolderOf(['Takeout', 'Google Photos', 'Trip', 'Nested']).name).toBe('Nested');
  });
});

describe('text helpers', () => {
  test('splitPath, cleanText and displayFileName', () => {
    expect(splitPath('a/b/c.jpg')).toEqual({ dirs: ['a', 'b'], baseName: 'c.jpg' });
    expect(splitPath('c.jpg')).toEqual({ dirs: [], baseName: 'c.jpg' });
    expect(cleanText('  a\u0000b  ', 10)).toBe('a b');
    expect(cleanText('x'.repeat(20), 5)).toBe('xxxxx');
    expect(cleanText('😀😀😀', 2)).toBe('😀😀');
    expect(displayFileName('\u0001')).toBe('file');
  });
});
