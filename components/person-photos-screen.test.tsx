import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewPhotoItem } from '@/lib/domain/photo';
import { assignPhotos } from '@/lib/usecases/photo-assign';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { PHOTO_PAGE_SIZE } from '@/hooks/use-photo-grid';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { PersonPhotosScreen } from './person-photos-screen';

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sub',
}));

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const t = en.person.photos;
const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32) ;
const item = (n: number, over: Partial<NewPhotoItem> = {}): NewPhotoItem => ({
  sha256: hash(n),
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: '2026-03-13T10:00:00Z',
  takenOffsetMinutes: null,
  dateSource: 'exif-local',
  latitude: null,
  longitude: null,
  description: '',
  album: '',
  fileName: `${n}.jpg`,
  ...over,
});
const HOSTILE = '<img src=x onerror="window.__pwned=1">.jpg';

/** Ana has pictures 1-3 (1 and 2 on 13 March, 3 on 2 February, 4 with no date, a video 5), Bo has 6; 7 is assigned to nobody. */
async function seed(lib: Lib, extra = 0) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  const bo = await createProfile(lib.deps, { displayName: 'Bo' });
  const items = [
    item(1),
    item(2, { takenAt: '2026-03-13T09:00:00Z', fileName: HOSTILE }),
    item(3, { takenAt: '2026-02-02T10:00:00Z' }),
    item(4, { dateSource: 'none', takenAt: null }),
    item(5, { kind: 'video', mime: 'video/mp4', takenAt: '2026-01-05T10:00:00Z' }),
    item(6),
    item(7),
    ...Array.from({ length: extra }, (_, i) => item(20 + i, { takenAt: `2025-06-01T10:${String(i % 60).padStart(2, '0')}:00Z`, fileName: `e${i}.jpg` })),
  ];
  await lib.client.call('importPhotoItems', {
    batchId: '00000000-0000-4000-8000-000000000501',
    source: 'takeout',
    sourceLabel: 'trip.zip',
    now: '2026-03-01T10:00:00Z',
    blobs: items.map((i) => ({ sha256: i.sha256, size: 1, mime: null })),
    items,
  });
  const mine = [1, 2, 3, 4, 5, ...Array.from({ length: extra }, (_, i) => 20 + i)].map(hash);
  await assignPhotos(lib.deps, { sha256s: mine, profileIds: [ana.id] });
  await assignPhotos(lib.deps, { sha256s: [hash(6)], profileIds: [bo.id] });
  return { ana, bo };
}

let view: (Rendered & Awaited<ReturnType<typeof renderWithLibrary>>) | undefined;
async function open(lib: Lib, id: string | null, messages: Record<string, unknown> = en) {
  search = id === null ? '' : `id=${id}`;
  view = await renderWithLibrary(<PersonPhotosScreen />, { lib, messages });
  await settle();
}
const all = (selector: string) => [...view!.container.querySelectorAll<HTMLElement>(selector)];
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector);
const tiles = () => all('section[data-day] li button');

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:t${++n}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('PersonPhotosScreen', () => {
  test('lists only this person’s pictures, newest first by day, with the count and a way back', async () => {
    const lib = await createTestLibrary();
    const { ana } = await seed(lib);
    await open(lib, ana.id);
    expect(q('h1')?.textContent).toBe(t.title);
    expect(view!.container.textContent).toContain('5 pictures assigned');
    expect(view!.container.textContent).toContain('Pictures from your photo collection that you assigned to Ana.');
    expect(all('section h2').map((h) => h.textContent)).toEqual(['Friday, March 13, 2026', 'Monday, February 2, 2026', 'Monday, January 5, 2026', en.photos.select.day.undated]);
    expect(tiles().map((b) => b.dataset.photo)).toEqual([hash(1), hash(2), hash(3), hash(5), hash(4)]);
    expect(tiles()).toHaveLength(5);
    expect(tiles().some((b) => b.dataset.photo === hash(6) || b.dataset.photo === hash(7))).toBe(false);
    expect(q(`a[href="/person?id=${ana.id}"]`)?.textContent).toBe('Back to Ana');
  });

  test('a tile is a plain button with a name that says what and when; names stay text; a video shows its name and reads nothing', async () => {
    const lib = await createTestLibrary();
    const { ana } = await seed(lib);
    await open(lib, ana.id);
    const names = tiles().map((b) => b.getAttribute('aria-label'));
    expect(names).toContain('Photo, March 13, 2026 at 10:00 AM');
    expect(names).toContain('Video, January 5, 2026 at 10:00 AM');
    expect(names).toContain('Photo, no date');
    expect(all('[role="option"], [role="listbox"]')).toHaveLength(0);
    expect(q('[data-photo] img[alt]')).toBeNull();
    expect(view!.container.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test('a tile opens the detail view, which walks to the next one and takes the picture out of this person only', async () => {
    const lib = await createTestLibrary();
    const { ana } = await seed(lib);
    await open(lib, ana.id);
    await click(tiles()[0]);
    await settle();
    const dialog = q('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.textContent).toContain('1 of 5');
    const firstSha = tiles()[0].dataset.photo!;
    const out = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Take this picture out of Ana')!;
    await click(out);
    await settle();
    expect(tiles()).toHaveLength(4);
    expect(tiles().some((b) => b.dataset.photo === firstSha)).toBe(false);
    expect(view!.container.textContent).toContain('4 pictures assigned');
    expect(q('[role="status"]')?.textContent).toContain('Picture taken out of Ana’s photos');
    // the picture is still in the collection and still Bo’s or nobody’s: it only left Ana
    const listed = await lib.client.call('listPhotoPictures', { scope: { show: 'unassigned' }, limit: 50 });
    expect(listed.pictures.map((p) => p.sha256)).toContain(firstSha);
  });

  test('taking out the last picture leaves the calm empty state with a way to choose more', async () => {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    const only = item(1);
    await lib.client.call('importPhotoItems', {
      batchId: '00000000-0000-4000-8000-000000000501',
      source: 'takeout',
      sourceLabel: 'trip.zip',
      now: '2026-03-01T10:00:00Z',
      blobs: [{ sha256: only.sha256, size: 1, mime: null }],
      items: [only],
    });
    await assignPhotos(lib.deps, { sha256s: [only.sha256], profileIds: [ana.id] });
    await open(lib, ana.id);
    await click(tiles()[0]);
    await settle();
    await click([...q('dialog')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Take this picture out of Ana')!);
    await settle();
    expect(tiles()).toHaveLength(0);
    expect(q('[data-testid="person-photos-empty"]')?.textContent).toContain('No pictures are assigned to Ana yet');
    expect(q('[data-testid="person-photos-empty"] a')?.getAttribute('href')).toBe('/photos/select');
  });

  test('a person with no pictures says so', async () => {
    const lib = await createTestLibrary();
    const bo = await createProfile(lib.deps, { displayName: 'Bo' });
    await open(lib, bo.id);
    expect(q('[data-testid="person-photos-empty"]')).not.toBeNull();
    expect(view!.container.textContent).not.toContain('pictures assigned');
  });

  test('pages with Show more', async () => {
    const lib = await createTestLibrary();
    const { ana } = await seed(lib, PHOTO_PAGE_SIZE);
    await open(lib, ana.id);
    expect(tiles()).toHaveLength(PHOTO_PAGE_SIZE);
    expect(view!.container.textContent).toContain(`Showing ${PHOTO_PAGE_SIZE} of ${PHOTO_PAGE_SIZE + 5}`);
    await click(all('button').find((b) => b.textContent === t.showMore));
    await settle();
    expect(tiles()).toHaveLength(PHOTO_PAGE_SIZE + 5);
  });

  test('an unknown, malformed or missing id is a calm not-found', async () => {
    const lib = await createTestLibrary();
    for (const id of ['00000000-0000-4000-8000-000000000999', 'not-a-uuid', null]) {
      await open(lib, id);
      expect(q('h1')?.textContent).toBe(en.person.notFoundTitle);
      view!.unmount();
    }
    view = undefined;
  });

  test('is worded in Catalan', async () => {
    const lib = await createTestLibrary();
    const { ana } = await seed(lib);
    await open(lib, ana.id, ca);
    expect(q('h1')?.textContent).toBe(ca.person.photos.title);
    expect(view!.container.textContent).toContain('5 fotos assignades');
  });
});
