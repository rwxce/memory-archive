import { describe, expect, test } from 'vitest';
import { isSafeFileName, matchMediaEntries, mimeFromFileName, normalizeMediaName } from './media';

describe('media matching', () => {
  test('normalizeMediaName tolerates case, (1) and separators', () => {
    expect(normalizeMediaName('Photo (1).JPG')).toBe(normalizeMediaName('photo.jpg'));
    expect(normalizeMediaName('IMG 20190424 WA0003.jpg')).toBe(
      normalizeMediaName('IMG-20190424-WA0003.jpg'),
    );
  });

  test('isSafeFileName rejects traversal and separators', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) expect(isSafeFileName(bad)).toBe(false);
    expect(isSafeFileName('IMG-1.jpg')).toBe(true);
  });

  test('matches refs to entries, skipping transcript, AppleDouble and unsafe names', () => {
    const entries = [
      { name: 'c/_chat.txt' },
      { name: 'c/IMG-1 (1).jpg' },
      { name: '__MACOSX/c/._VID-2.mp4' },
      { name: 'c/..' },
    ];
    const res = matchMediaEntries(entries, ['IMG-1.jpg', 'VID-2.mp4', '..', 'IMG-1.jpg']);
    expect(res.matches).toEqual([
      { ref: 'IMG-1.jpg', entry: { name: 'c/IMG-1 (1).jpg' }, fileName: 'IMG-1 (1).jpg' },
    ]);
    expect(res.unresolved).toEqual(['VID-2.mp4', '..']);
  });

  test('mimeFromFileName maps known extensions case-insensitively and is null otherwise', () => {
    expect(mimeFromFileName('IMG-1.JPG')).toBe('image/jpeg');
    expect(mimeFromFileName('a.b.mp4')).toBe('video/mp4');
    expect(mimeFromFileName('voice.opus')).toBe('audio/ogg');
    expect(mimeFromFileName('archive.zip')).toBeNull();
    expect(mimeFromFileName('noextension')).toBeNull();
  });
});
