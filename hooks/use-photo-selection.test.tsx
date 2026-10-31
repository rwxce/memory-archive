import { describe, expect, test } from 'vitest';
import { act } from 'react';
import { render } from '@/components/test-utils';
import type { PhotoPicture } from '@/lib/domain/photo';
import { usePhotoSelection, type PhotoSelection } from './use-photo-selection';

const picture = (n: number): PhotoPicture => ({
  sha256: n.toString(16).padStart(2, '0').repeat(32),
  kind: 'photo',
  mime: null,
  takenAt: null,
  takenOffsetMinutes: null,
  dateSource: 'none',
  fileName: `${n}.jpg`,
  albums: [],
  albumCount: 0,
  sources: [],
  itemCount: 1,
  assignedProfileIds: [],
});

async function probe(max: number) {
  const box: { current?: PhotoSelection } = {};
  function Probe() {
    box.current = usePhotoSelection(max);
    return null;
  }
  await render(<Probe />);
  return box as { current: PhotoSelection };
}

describe('usePhotoSelection', () => {
  test('toggles, remembers the last one chosen, and clears', async () => {
    const s = await probe(10);
    await act(async () => void s.current.toggle(picture(1)));
    await act(async () => void s.current.toggle(picture(2)));
    expect(s.current.count).toBe(2);
    expect(s.current.anchor.current).toBe(picture(2).sha256);
    await act(async () => void s.current.toggle(picture(1)));
    expect(s.current.has(picture(1).sha256)).toBe(false);
    await act(async () => s.current.clear());
    expect(s.current.count).toBe(0);
  });

  test('never holds more than the cap: one by one it refuses, in bulk it adds what fits and says so', async () => {
    const s = await probe(3);
    const many = [1, 2, 3, 4, 5].map(picture);
    let capped = false;
    await act(async () => void (capped = s.current.setMany(many, true).capped));
    expect(capped).toBe(true);
    expect(s.current.pictures.map((p) => p.fileName)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    let refused = '';
    await act(async () => void (refused = s.current.toggle(picture(4))));
    expect(refused).toBe('cap');
    expect(s.current.count).toBe(3);
    await act(async () => void s.current.setMany([picture(1)], false));
    expect(s.current.count).toBe(2);
    await act(async () => s.current.drop(new Set([picture(2).sha256])));
    expect(s.current.count).toBe(1);
  });
});
