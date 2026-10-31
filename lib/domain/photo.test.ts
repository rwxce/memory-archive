import { describe, expect, test } from 'vitest';
import { betterDate, isGuessedDate, isPhotoDateSource, isPhotoOffset, isTakenAt, photoDisplayDate, takenAtFromEpochMs, type PhotoDateSource } from './photo';

describe('date source', () => {
  test('only the known labels are accepted', () => {
    for (const s of ['sidecar', 'exif', 'exif-local', 'file-modified', 'none']) expect(isPhotoDateSource(s)).toBe(true);
    for (const s of ['', 'EXIF', 'guess', null, undefined, 3]) expect(isPhotoDateSource(s)).toBe(false);
  });

  test('only file-modified is a guess', () => {
    expect((['sidecar', 'exif', 'exif-local', 'none'] as PhotoDateSource[]).some(isGuessedDate)).toBe(false);
    expect(isGuessedDate('file-modified')).toBe(true);
  });

  test('betterDate prefers the more trustworthy source', () => {
    const at = (dateSource: PhotoDateSource, n = 0) => ({ dateSource, takenAt: '2019-07-01T10:00:00Z', takenOffsetMinutes: null, fileName: 'a.jpg', n });
    expect(betterDate(at('file-modified'), at('exif', 1)).dateSource).toBe('exif');
    expect(betterDate(at('exif'), at('exif-local', 1)).n).toBe(0);
    expect(betterDate(at('none'), at('file-modified', 1)).dateSource).toBe('file-modified');
    expect(betterDate(at('exif'), at('sidecar', 1)).dateSource).toBe('sidecar');
  });

  test('a tie is broken by the earliest takenAt, then the offset, then the name, whatever the order', () => {
    const it = (takenAt: string | null, fileName = 'b.jpg', takenOffsetMinutes: number | null = null) => ({ dateSource: 'exif' as PhotoDateSource, takenAt, takenOffsetMinutes, fileName });
    const pairs = [
      [it('2019-07-01T10:00:00Z'), it('2019-07-02T10:00:00Z')],
      [it('2019-07-01T10:00:00Z', 'z.jpg'), it('2019-07-01T10:00:00Z', 'a.jpg')],
      [it('2019-07-01T10:00:00Z', 'a.jpg', 120), it('2019-07-01T10:00:00Z', 'a.jpg', 60)],
      [it('2019-07-01T10:00:00Z'), it(null)],
    ];
    for (const [x, y] of pairs) expect(betterDate(x, y)).toBe(betterDate(y, x));
    expect(betterDate(pairs[0][1], pairs[0][0]).takenAt).toBe('2019-07-01T10:00:00Z');
    expect(betterDate(pairs[1][0], pairs[1][1]).fileName).toBe('a.jpg');
    expect(betterDate(pairs[2][0], pairs[2][1]).takenOffsetMinutes).toBe(60);
    expect(betterDate(pairs[3][1], pairs[3][0]).takenAt).not.toBeNull();
  });
});

describe('photoDisplayDate', () => {
  const madrid = (ms: number) => (ms >= Date.parse('2019-03-31T01:00:00Z') && ms < Date.parse('2019-10-27T01:00:00Z') ? 120 : 60);
  const item = (dateSource: PhotoDateSource, takenAt: string | null, takenOffsetMinutes: number | null = null) => ({ dateSource, takenAt, takenOffsetMinutes });

  test('exif with an offset shows the camera wall clock, so +10:00 at 00:30 stays on its own day', () => {
    // 00:30 on the 5th at +10:00 is 14:30 UTC on the 4th.
    expect(photoDisplayDate(item('exif', '2019-07-04T14:30:00Z', 600), madrid)).toEqual({ day: '2019-07-05', time: '00:30', zone: 'local-digits', approximate: false });
    expect(photoDisplayDate(item('exif', '2019-07-04T14:30:00Z', 600))).toMatchObject({ day: '2019-07-05' });
  });

  test('exif-local shows the stored digits as written, never converted', () => {
    expect(photoDisplayDate(item('exif-local', '2019-07-02T23:30:00Z'), madrid)).toEqual({ day: '2019-07-02', time: '23:30', zone: 'local-digits', approximate: false });
  });

  test('a sidecar instant is shown in the viewer zone', () => {
    expect(photoDisplayDate(item('sidecar', '2019-07-01T22:30:00Z'), madrid)).toEqual({ day: '2019-07-02', time: '00:30', zone: 'utc', approximate: false });
    expect(photoDisplayDate(item('sidecar', '2019-07-01T22:30:00Z'))).toMatchObject({ day: '2019-07-01', time: '22:30' });
  });

  test('exif without a stored offset (an older row) falls back to the instant in the viewer zone', () => {
    expect(photoDisplayDate(item('exif', '2019-07-01T22:30:00Z'), madrid)).toMatchObject({ day: '2019-07-02', zone: 'utc' });
  });

  test('file-modified is approximate; none is unknown', () => {
    expect(photoDisplayDate(item('file-modified', '2020-05-05T05:05:05Z'))).toMatchObject({ day: '2020-05-05', approximate: true });
    expect(photoDisplayDate(item('none', null))).toBeNull();
  });
});

describe('isPhotoOffset', () => {
  test.each([0, 60, -180, 330, 345, 840, -840])('%s is a UTC offset', (n) => expect(isPhotoOffset(n)).toBe(true));
  test.each([841, -841, 7, 1.5, NaN, '60', null, 899])('%s is not', (n) => expect(isPhotoOffset(n)).toBe(false));
});

describe('takenAtFromEpochMs', () => {
  const now = Date.parse('2026-03-01T10:00:00Z');
  test('a plausible time becomes a UTC instant at second resolution', () => {
    const value = takenAtFromEpochMs(Date.parse('2019-07-01T10:00:00.789Z'), now);
    expect(value).toBe('2019-07-01T10:00:00Z');
    expect(isTakenAt(value)).toBe(true);
  });
  test.each([0, -5, 1000, NaN, Infinity, '2019', null, undefined, now + 3 * 86_400_000])('%s is not a date', (value) => {
    expect(takenAtFromEpochMs(value, now)).toBeNull();
  });
  test('a clock a few hours ahead is tolerated', () => {
    expect(takenAtFromEpochMs(now + 3_600_000, now)).not.toBeNull();
  });
});
