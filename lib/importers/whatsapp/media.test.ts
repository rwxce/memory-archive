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

  test('an Android <name>.txt transcript is never matched as media', () => {
    const entries = [{ name: 'Chat de WhatsApp con Ana.txt' }, { name: 'IMG-1.jpg' }];
    const res = matchMediaEntries(entries, ['Chat de WhatsApp con Ana.txt', 'IMG-1.jpg']);
    expect(res.matches.map((m) => m.entry.name)).toEqual(['IMG-1.jpg']);
    expect(res.unresolved).toEqual(['Chat de WhatsApp con Ana.txt']);
    // An explicit transcript (chosen with the ZIP-name tiebreak) is excluded even among several .txt.
    const several = [{ name: 'a.txt' }, { name: 'b.txt' }];
    expect(matchMediaEntries(several, ['a.txt', 'b.txt'], several[0]).matches.map((m) => m.entry.name)).toEqual(['b.txt']);
  });

  test('mimeFromFileName maps known extensions case-insensitively and is null otherwise', () => {
    expect(mimeFromFileName('IMG-1.JPG')).toBe('image/jpeg');
    expect(mimeFromFileName('a.b.mp4')).toBe('video/mp4');
    expect(mimeFromFileName('voice.opus')).toBe('audio/ogg');
    expect(mimeFromFileName('archive.zip')).toBeNull();
    expect(mimeFromFileName('noextension')).toBeNull();
  });
});
