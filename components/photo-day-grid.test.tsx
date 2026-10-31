import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { usePhotoSelection } from '@/hooks/use-photo-selection';
import type { PhotoPicture } from '@/lib/domain/photo';
import { render, type Rendered } from './test-utils';
import { PhotoDayGrid } from './photo-day-grid';
import { groupByDay, type PhotoDay } from './photo-days';

const renders = new Map<string, number>();
vi.mock('@/hooks/use-photo-image', () => ({
  usePhotoImage: (picture: { sha256: string }) => {
    renders.set(picture.sha256, (renders.get(picture.sha256) ?? 0) + 1);
    return { status: 'idle' };
  },
}));

const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const picture = (n: number, over: Partial<PhotoPicture> = {}): PhotoPicture => ({
  sha256: hash(n),
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

const noop = () => undefined; // stable, like the screen's own callbacks

function Harness({ days }: { days: PhotoDay[] }) {
  const selection = usePhotoSelection();
  const [selecting, setSelecting] = useState(false);
  return <PhotoDayGrid days={days} selection={selection} selecting={selecting} onSelecting={setSelecting} onOpen={noop} onCap={noop} />;
}

let view: Rendered | undefined;
beforeEach(() => renders.clear());
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('PhotoDayGrid', () => {
  test('choosing one picture re-renders that tile, not the others (memo is effective)', async () => {
    const days = groupByDay(Array.from({ length: 30 }, (_, i) => picture(i + 1)));
    view = await render(<Harness days={days} />);
    const before = new Map(renders);
    expect(before.size).toBe(30);
    const tile = view.container.querySelector<HTMLElement>(`[data-photo="${hash(5)}"]`)!;
    await act(async () => void tile.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(view.container.querySelector(`[data-photo="${hash(5)}"]`)!.getAttribute('aria-selected')).toBe('true');
    // Selecting mode turned on (every tile's `selecting` flag changed once): that is one render each. Further choices cost one tile each.
    const afterFirst = new Map(renders);
    await act(async () => view!.container.querySelector<HTMLElement>(`[data-photo="${hash(9)}"]`)!.click());
    await act(async () => view!.container.querySelector<HTMLElement>(`[data-photo="${hash(9)}"]`)!.click());
    const changed = [...renders].filter(([sha, n]) => n !== afterFirst.get(sha)).map(([sha]) => sha);
    expect(changed).toEqual([hash(9)]);
    expect(renders.get(hash(9))! - afterFirst.get(hash(9))!).toBe(2);
  });

  test('a day that shows up twice is labelled as acting on the group shown', async () => {
    const days = groupByDay([picture(1), picture(2, { takenAt: '2026-03-12T10:00:00Z' }), picture(3)]);
    view = await render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Harness days={days} />
      </NextIntlClientProvider>,
    );
    const labels = [...view.container.querySelectorAll<HTMLElement>('section button')].map((b) => b.getAttribute('aria-label'));
    expect(labels[0]).toContain('shown in this group');
    expect(labels[1]).not.toContain('shown in this group');
    expect(labels[2]).toContain('shown in this group');
  });
});
