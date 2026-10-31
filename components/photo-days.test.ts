import { describe, expect, test } from 'vitest';
import type { PhotoPicture } from '@/lib/domain/photo';
import { groupByDay } from './photo-days';

const picture = (n: number, over: Partial<PhotoPicture> = {}): PhotoPicture => ({
  sha256: n.toString(16).padStart(2, '0').repeat(32),
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: '2026-03-13T10:00:00Z',
  takenOffsetMinutes: null,
  dateSource: 'exif-local',
  fileName: `${n}.jpg`,
  albums: [],
  albumCount: 0,
  sources: ['loose'],
  itemCount: 1,
  assignedProfileIds: [],
  ...over,
});

describe('groupByDay', () => {
  test('starts a new group whenever the displayed day changes, and keeps the order given', () => {
    const days = groupByDay([picture(1), picture(2), picture(3, { takenAt: '2026-03-12T23:59:00Z' }), picture(4, { takenAt: '2026-03-13T09:00:00Z' })]);
    expect(days.map((d) => [d.day, d.pictures.length])).toEqual([['2026-03-13', 2], ['2026-03-12', 1], ['2026-03-13', 1]]);
    // The same day twice still gets two distinct keys.
    expect(new Set(days.map((d) => d.key)).size).toBe(3);
  });

  test('a camera offset keeps the photo on its own day, and the viewer zone shifts a UTC instant', () => {
    // 14:30 UTC at +10:00 is 00:30 the next day on the camera's clock.
    const exif = picture(1, { dateSource: 'exif', takenAt: '2019-07-01T14:30:00Z', takenOffsetMinutes: 600 });
    const sidecar = picture(2, { dateSource: 'sidecar', takenAt: '2019-07-01T23:30:00Z' });
    expect(groupByDay([exif], () => 0)[0].day).toBe('2019-07-02');
    expect(groupByDay([sidecar], () => 0)[0].day).toBe('2019-07-01');
    expect(groupByDay([sidecar], () => 120)[0].day).toBe('2019-07-02');
  });

  test('marks a day whose dates are all guesses, and puts undated pictures in a last group', () => {
    const guess = (n: number) => picture(n, { dateSource: 'file-modified', takenAt: '2020-01-01T12:00:00Z' });
    const days = groupByDay([guess(1), guess(2), picture(3, { dateSource: 'none', takenAt: null }), picture(4, { dateSource: 'none', takenAt: null })], () => 0);
    expect(days.map((d) => [d.day, d.allEstimated])).toEqual([['2020-01-01', true], [null, false]]);
    expect(days[1].pictures).toHaveLength(2);
    const mixed = groupByDay([guess(1), picture(2, { takenAt: '2020-01-01T08:00:00Z' })], () => 0);
    expect(mixed[0].allEstimated).toBe(false);
  });
});
