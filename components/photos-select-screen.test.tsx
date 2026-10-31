import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewPhotoItem } from '@/lib/domain/photo';
import { archiveProfile, createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, type, type Rendered } from './test-utils';
import { THUMB_MIN_SOURCE_BYTES } from '@/lib/usecases/tile-image';
import { PHOTO_PAGE_SIZE } from '@/hooks/use-photo-grid';
import { JUMP_PAGES_MAX, PhotosSelectScreen } from './photos-select-screen';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/photos/select',
}));

/** An IntersectionObserver the test drives: tiles are "far" until `intersect` says otherwise. */
const observers = new Set<{ element: Element; callback: IntersectionObserverCallback }>();
class FakeObserver {
  private entry?: { element: Element; callback: IntersectionObserverCallback };
  constructor(private callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    this.entry = { element, callback: this.callback };
    observers.add(this.entry);
  }
  disconnect() {
    if (this.entry) observers.delete(this.entry);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
const intersect = (element: Element, isIntersecting: boolean) =>
  act(async () => {
    for (const o of observers) if (o.element === element) o.callback([{ isIntersecting, target: element } as IntersectionObserverEntry], {} as IntersectionObserver);
  });

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
type View = Rendered & Awaited<ReturnType<typeof renderWithLibrary>>;
const t = en.photos.select;
const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
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
  album: 'Trip',
  fileName: `${n}.jpg`,
  ...over,
});

let batchNo = 0;
async function seed(lib: Lib, items: NewPhotoItem[], stored: number[] = []) {
  for (const n of stored) await lib.deps.blobStore.put(new TextEncoder().encode(`bytes-${n}`));
  await lib.client.call('importPhotoItems', {
    batchId: uuid(0x500 + ++batchNo),
    source: 'takeout',
    sourceLabel: 'trip.zip',
    now: '2026-03-01T10:00:00Z',
    blobs: [...new Set(items.map((i) => i.sha256))].map((sha256) => ({ sha256, size: 1, mime: null })),
    items,
  });
}
const person = (lib: Lib, name: string) => createProfile(lib.deps, { displayName: name });

// 1,2: 13 March 2026 · 3: 2 July 2019 by the camera's own offset · 4: a guess · 5: no date.
const FIVE = () => [
  item(1),
  item(2, { takenAt: '2026-03-13T10:05:00Z' }),
  item(3, { dateSource: 'exif', takenAt: '2019-07-01T14:30:00Z', takenOffsetMinutes: 600, album: 'Lisbon' }),
  item(4, { dateSource: 'file-modified', takenAt: '2018-01-05T12:00:00Z', album: '' }),
  item(5, { dateSource: 'none', takenAt: null, album: '' }),
];

let view: View | undefined;
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...view!.container.querySelectorAll<HTMLElement>(selector)];
const tile = (n: number) => q(`[data-photo="${hash(n)}"]`)!;
const text = () => view!.container.textContent!;
const button = (label: string | RegExp, root: ParentNode = view!.container) =>
  [...root.querySelectorAll<HTMLElement>('button')].find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
const dialogs = () => all('dialog');
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
const clickWith = (el: Element, init: MouseEventInit) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });

async function open(lib: Lib, messages: Record<string, unknown> = en) {
  view = await renderWithLibrary(<PhotosSelectScreen />, { lib, messages });
  await settle();
  return view;
}
const selectMode = () => click(q('[data-testid="select-toggle"]'));

beforeEach(() => {
  observers.clear();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:t${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('the picture grid', () => {
  test('groups by displayed day with sticky headers, marks estimates, and puts undated pictures last', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib, en);
    // Not assigned is the default filter; everything is in it.
    expect(button(/^Not assigned/)!.getAttribute('aria-pressed')).toBe('true');
    const days = all('[data-day]');
    expect(days.map((d) => d.dataset.day)).toEqual(['2026-03-13', '2019-07-02', days[2].dataset.day, 'undated']);
    expect(days[0].querySelectorAll('[data-photo]')).toHaveLength(2);
    expect(days[1].querySelectorAll('[data-photo]')).toHaveLength(1);
    expect(days[3].querySelector('h3')!.textContent).toContain(t.day.undated);
    // The guess is marked on the tile and in its name; a real date is not.
    expect(tile(4).textContent).toContain(t.tile.estimated);
    expect(tile(4).getAttribute('aria-label')).toMatch(/about .*estimated/);
    expect(tile(1).textContent).not.toContain(t.tile.estimated);
    expect(tile(5).getAttribute('aria-label')).toBe('Photo, no date');
    expect(days[0].querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe('true');
    expect(days[0].querySelector('div')!.className).toContain('sticky');
    // Counts on the filters.
    expect(text()).toContain('Not assigned5');
    expect(text()).toContain('Assigned0');
  });

  test('speaks Catalan', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib, ca);
    expect(text()).toContain(ca.photos.select.title);
    expect(text()).toContain(ca.photos.select.day.undated);
    expect(tile(5).getAttribute('aria-label')).toBe('Foto, sense data');
  });

  test('says so when there is nothing to show, per filter', async () => {
    const lib = await createTestLibrary();
    await open(lib);
    expect(q('[data-testid="select-empty"]')!.textContent).toContain(t.empty.unassigned);
    await click(button(/^Assigned/));
    await settle();
    expect(q('[data-testid="select-empty"]')!.textContent).toContain(t.empty.assigned);
    await click(button(/^All/));
    await settle();
    expect(q('[data-testid="select-empty"]')!.textContent).toContain(t.empty.all);
    expect(q('[data-testid="select-empty"] a')!.getAttribute('href')).toBe('/photos');
  });

  test('pages by cursor when the end of the list comes near, and keeps the choice across pages', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const lib = await createTestLibrary();
    await seed(lib, Array.from({ length: 130 }, (_, i) => item(i + 1, { takenAt: `2026-03-13T10:${String(i % 60).padStart(2, '0')}:00Z`, fileName: `${i + 1}.jpg` })));
    await open(lib);
    expect(all('[data-photo]')).toHaveLength(120);
    await selectMode();
    await click(all('[data-photo]')[0]);
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('1 picture selected');
    await click(button(t.showMore));
    await settle();
    expect(all('[data-photo]')).toHaveLength(130);
    expect(button(t.showMore)).toBeUndefined();
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('1 picture selected');
  });
});

describe('choosing', () => {
  test('a tap opens the picture until Select is on; then it chooses; Shift-click picks a range; Clear empties', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    await click(tile(1));
    expect(dialogs().some((d) => d.hasAttribute('open'))).toBe(true);
    await key(q('dialog[aria-label]')!, 'Escape'); // closes through the dialog's own cancel
    await act(async () => q('dialog[aria-label]')!.dispatchEvent(new Event('cancel', { cancelable: true })));
    await selectMode();
    await click(tile(1));
    expect(tile(1).getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('1 picture selected');
    await clickWith(tile(4), { shiftKey: true });
    expect(all('[aria-selected="true"]')).toHaveLength(3); // the list runs 2, 1, 3, 4, 5
    await click(button(t.clear));
    expect(all('[aria-selected="true"]')).toHaveLength(0);
    expect(q('[data-testid="select-bar"]')).toBeNull();
  });

  test('keyboard: arrows move one tile in the tab order, Space chooses, Shift+arrow extends, Ctrl+A chooses all loaded, Escape keeps the choice', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    // Newest first: 2, 1, 3, 4, 5. Only the first is in the tab order.
    expect(tile(2).tabIndex).toBe(0);
    expect(tile(1).tabIndex).toBe(-1);
    tile(2).focus();
    await key(tile(2), 'ArrowRight');
    expect(document.activeElement).toBe(tile(1));
    await settle();
    expect(tile(1).tabIndex).toBe(0);
    expect(tile(2).tabIndex).toBe(-1);
    await key(tile(1), ' ');
    expect(tile(1).getAttribute('aria-selected')).toBe('true');
    await key(tile(1), 'ArrowRight', { shiftKey: true });
    expect(all('[aria-selected="true"]').map((e) => e.dataset.photo).sort()).toEqual([hash(1), hash(3)].sort());
    await key(tile(3), 'a', { ctrlKey: true });
    expect(all('[aria-selected="true"]')).toHaveLength(5);
    // A stray Escape does not lose a choice; Clear does.
    await key(tile(3), 'Escape');
    expect(all('[aria-selected="true"]')).toHaveLength(5);
    await click(button(t.clear));
    expect(all('[aria-selected="true"]')).toHaveLength(0);
    await key(tile(1), 'End');
    expect(document.activeElement).toBe(tile(5));
  });

  test('"Select day" chooses the whole day and a second press lets it go', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    const header = q('[data-day="2026-03-13"] button')!;
    expect(header.getAttribute('aria-label')).toContain('2 pictures');
    await click(header);
    expect(all('[aria-selected="true"]')).toHaveLength(2);
    expect(header.getAttribute('aria-pressed')).toBe('true');
    await click(header);
    expect(all('[aria-selected="true"]')).toHaveLength(0);
  });

  test('a long press on a touch screen starts selecting, and the click that follows does not undo it', async () => {
    {
      const lib = await createTestLibrary();
      await seed(lib, FIVE());
      await open(lib);
      const el = tile(1);
      await act(async () => el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
      await act(async () => void (await new Promise((r) => setTimeout(r, 650))));
      expect(el.getAttribute('aria-selected')).toBe('true');
      await click(el);
      expect(el.getAttribute('aria-selected')).toBe('true');
      expect(q('[data-testid="select-toggle"]')!.getAttribute('aria-pressed')).toBe('true');
    }
  });
});

describe('assigning', () => {
  async function chooseAndOpenPicker(lib: Lib, shas: number[]) {
    await selectMode();
    for (const n of shas) await click(tile(n));
    await click(button(t.assignButton));
    await settle();
  }

  test('says there is nobody to assign to, with a way to People', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    await chooseAndOpenPicker(lib, [1]);
    expect(q('[data-testid="assign-nobody"]')!.textContent).toContain(t.assign.nobody);
    expect(q('[data-testid="assign-nobody"] a')!.getAttribute('href')).toBe('/people');
    expect(button(t.assign.next)!.getAttribute('aria-disabled')).toBe('true');
  });

  test('picks people (archived last and labelled), confirms in words, assigns exactly the chosen pictures, then undoes only what it added', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    const ana = await person(lib, 'Ana');
    const bru = await person(lib, 'Bru');
    const old = await person(lib, 'Abu');
    await archiveProfile(lib.deps, old.id);
    // Picture 2 is already Ana's: assigning it again must not be undone later.
    await lib.client.call('assignPhotos', { sha256s: [hash(2)], profileIds: [ana.id], now: '2026-03-01T10:00:00Z' });
    await open(lib, en);
    await click(button(/^All/));
    await settle();
    await chooseAndOpenPicker(lib, [1, 2, 3]);
    const labels = all('dialog[aria-labelledby="assign-title"] label').map((l) => l.textContent);
    expect(labels).toEqual(['AAna', 'BBru', 'AAbu(archived)']);
    // Nothing happens until Continue is possible and Assign is pressed.
    await click(button(t.assign.next));
    expect(q('dialog[aria-labelledby="assign-title"] h2')!.textContent).toBe(t.assign.title);
    for (const label of all('dialog[aria-labelledby="assign-title"] input[type="checkbox"]').slice(0, 2)) await click(label);
    await click(button(t.assign.next));
    const confirm = q('dialog[aria-labelledby="assign-title"]')!;
    expect(confirm.textContent).toContain('3 pictures will be assigned to:');
    expect(q('[data-testid="assign-confirm-people"]')!.textContent).toBe('AnaBru');
    expect(confirm.textContent).toContain(t.assign.only);
    expect(await lib.client.call('countPhotoPictures')).toMatchObject({ unassigned: 4 });
    await click(button(t.assign.confirm, confirm));
    await settle();
    // 3 pictures x 2 people = 6 pairs, 1 already there.
    const result = q('[data-testid="select-result"]')!;
    expect(result.textContent).toContain('5 assignments added.');
    expect(result.textContent).toContain('1 was already there.');
    expect(document.activeElement).toBe(result);
    expect(await lib.client.call('countPhotoPictures')).toMatchObject({ unassigned: 2 });
    expect(q('[data-testid="select-bar"]')).toBeNull();
    expect(tile(1).getAttribute('aria-label')).toContain('already assigned');
    // Undo takes back the five it added; Ana keeps picture 2.
    await click(button(t.result.undo));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('5 assignments were taken back.');
    const kept = await lib.client.call('listPhotoPictures', { scope: { show: 'assigned' }, limit: 10 });
    expect(kept.pictures.map((p) => [p.sha256, p.assignedProfileIds])).toEqual([[hash(2), [ana.id]]]);
    expect(bru.id).toBeTruthy();
  });

  test('in the Not assigned list the assigned pictures leave it, calmly announced; the count follows', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await person(lib, 'Ana');
    await open(lib);
    await chooseAndOpenPicker(lib, [1, 2]);
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    expect(q(`[data-photo="${hash(1)}"]`)).toBeNull();
    expect(q(`[data-photo="${hash(3)}"]`)).not.toBeNull();
    expect(q('[role="status"]')!.textContent).toBe('2 pictures were assigned and left this list.');
    expect(text()).toContain('Not assigned3');
    expect(text()).toContain('Assigned2');
  });

  test('a failed assignment says so, writes nothing and keeps the choice', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await person(lib, 'Ana');
    await open(lib);
    await chooseAndOpenPicker(lib, [1]);
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    const call = lib.deps.client.call.bind(lib.deps.client);
    vi.spyOn(lib.deps.client, 'call').mockImplementation(((name: string, ...rest: unknown[]) => (name === 'assignPhotos' ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => unknown)(name, ...rest))) as never);
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('may not have been assigned');
    expect(tile(1).getAttribute('aria-selected')).toBe('true');
    expect(button(t.result.undo)).toBeUndefined();
  });

  test('the picker searches when there are more than eight people', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    for (let i = 1; i <= 9; i++) await person(lib, `Person ${i}`);
    await person(lib, 'Zoe');
    await open(lib);
    await chooseAndOpenPicker(lib, [1]);
    const search = q('input[type="search"]')!;
    await type(search, 'zo');
    expect(all('dialog[aria-labelledby="assign-title"] li')).toHaveLength(1);
    await type(search, 'nobody-like-this');
    expect(text()).toContain(t.assign.noMatch);
  });

  test('Cancel closes the picker and changes nothing', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await person(lib, 'Ana');
    await open(lib);
    await chooseAndOpenPicker(lib, [1]);
    await click(button(t.assign.cancel));
    expect(q('dialog[aria-labelledby="assign-title"]')!.hasAttribute('open')).toBe(false);
    expect(tile(1).getAttribute('aria-selected')).toBe('true');
    expect(await lib.client.call('countPhotoPictures')).toMatchObject({ unassigned: 5 });
  });
});

describe('the picture detail', () => {
  test('shows the date and where it comes from, albums, sources and who has it; Take out removes one person; Next/Previous walk the list; Escape closes and the tile gets focus back', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    const ana = await person(lib, 'Ana');
    await lib.client.call('assignPhotos', { sha256s: [hash(3)], profileIds: [ana.id], now: '2026-03-01T10:00:00Z' });
    await open(lib);
    await click(button(/^All/));
    await settle();
    await click(tile(3));
    const detail = q('dialog[aria-label]')!;
    expect(detail.hasAttribute('open')).toBe(true);
    expect(detail.textContent).toContain('July 2, 2019');
    expect(detail.textContent).toContain(t.detail.from.exif);
    expect(detail.textContent).toContain('Lisbon');
    expect(detail.textContent).toContain('Google Takeout');
    expect(q('[data-testid="detail-people"]')!.textContent).toContain('Ana');
    expect(detail.textContent).toContain('3 of 5');
    await click(button(t.detail.next, detail));
    expect(detail.textContent).toContain(t.detail.from['file-modified']);
    expect(q('[data-testid="detail-date"]')!.textContent).toContain('About');
    await click(button(t.detail.previous, detail));
    await click(button(t.detail.unassign, detail));
    await settle();
    expect(detail.textContent).toContain(t.detail.assignedNone);
    expect((await lib.client.call('countPhotoPictures')).unassigned).toBe(5);
    await act(async () => detail.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(detail.hasAttribute('open')).toBe(false);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(document.activeElement).toBe(tile(3));
  });

  test('in the Assigned list, taking a picture out of its last person drops it and shows its neighbour', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    const ana = await person(lib, 'Ana');
    await lib.client.call('assignPhotos', { sha256s: [hash(1), hash(2)], profileIds: [ana.id], now: '2026-03-01T10:00:00Z' });
    await open(lib);
    await click(button(/^Assigned/));
    await settle();
    await click(tile(1));
    await click(button(t.detail.unassign, q('dialog[aria-label]')!));
    await settle();
    expect(q(`[data-photo="${hash(1)}"]`)).toBeNull();
    expect(q('dialog[aria-label]')!.textContent).toContain('1 of 1');
  });

  test('a video plays from its file with controls and a hostile file name stays text', async () => {
    const lib = await createTestLibrary();
    const hostile = '<img src=x onerror="window.__pwned=1">.mp4';
    await lib.deps.blobStore.put(new TextEncoder().encode('bytes-7'));
    const sha = (await lib.deps.blobStore.list())[0];
    await seed(lib, [item(7, { sha256: sha, kind: 'video', mime: 'video/mp4', fileName: hostile, album: '<b>x</b>' })]);
    await open(lib);
    await click(q('[data-photo]')!);
    await settle();
    const detail = q('dialog[aria-label]')!;
    expect(detail.querySelector('video')!.hasAttribute('controls')).toBe(true);
    expect(detail.textContent).toContain(hostile);
    expect(detail.querySelector('img[src="x"]')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // The tile of a video reads nothing: a play badge and its name.
    expect(q('[data-photo]')!.querySelector('img')).toBeNull();
  });
});

describe('tiles', () => {
  test('a tile reads its thumbnail only near the screen, frees the URL when it leaves, and a missing file shows a calm placeholder', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const lib = await createTestLibrary();
    await lib.deps.blobStore.put(new TextEncoder().encode('bytes-1'));
    const sha = (await lib.deps.blobStore.list())[0];
    await seed(lib, [item(1, { sha256: sha }), item(2)]);
    await open(lib);
    const real = q(`[data-photo="${sha}"]`)!;
    const gone = tile(2);
    expect(real.querySelector('img')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await intersect(real, true);
    await settle();
    expect(real.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/);
    expect(real.querySelector('img')!.getAttribute('alt')).toBe('');
    await intersect(real, false);
    await settle();
    expect(real.querySelector('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    await intersect(gone, true);
    await settle();
    expect(gone.querySelector('[data-testid="photo-tile-failed"]')!.textContent).toBe(t.tile.failed);
    // Revoked again on unmount.
    await intersect(real, true);
    await settle();
    const before = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    view!.unmount();
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.length).toBe(before + 1);
    view = undefined;
  });
});

describe('review fixes', () => {
  async function assignTo(lib: Lib, shas: number[], name = 'Ana') {
    await selectMode();
    for (const n of shas) await click(tile(n));
    await click(button(t.assignButton));
    await settle();
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    return name;
  }
  const failCalls = (lib: Lib, name: string, times = Infinity) => {
    const call = lib.deps.client.call.bind(lib.deps.client);
    let left = times;
    return vi.spyOn(lib.deps.client, 'call').mockImplementation(((n: string, ...rest: unknown[]) =>
      n === name && left-- > 0 ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => unknown)(n, ...rest)) as never);
  };

  test('a jump whose next page cannot be read stops, says so, and does not retry forever', async () => {
    const lib = await createTestLibrary();
    await seed(lib, [
      ...Array.from({ length: 130 }, (_, i) => item(i + 1, { takenAt: `2026-03-13T10:${String(i % 60).padStart(2, '0')}:00Z` })),
      item(200, { takenAt: '2019-07-01T10:00:00Z' }),
    ]);
    await open(lib);
    const spy = vi.spyOn(lib.deps.client, 'call');
    const call = lib.deps.client.call.bind(lib.deps.client);
    spy.mockImplementation(((n: string, p: { cursor?: unknown }, ...rest: unknown[]) =>
      n === 'listPhotoPictures' && p?.cursor ? Promise.reject(new Error('io')) : (call as (...a: unknown[]) => unknown)(n, p, ...rest)) as never);
    const select = q('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '2019-07';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await settle();
    const pageReads = spy.mock.calls.filter(([n, p]) => n === 'listPhotoPictures' && (p as { cursor?: unknown }).cursor).length;
    expect(pageReads).toBe(1);
    expect(q('[role="status"]')!.textContent).toBe(t.jump.failed);
  });

  test('a jump to a month that is not in the list says so calmly', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    // The month list is stale (read before another tab removed the pictures): the month is offered but is not in the list.
    const select = q('select') as HTMLSelectElement;
    const extra = document.createElement('option');
    extra.value = '2001-01';
    select.appendChild(extra);
    await act(async () => {
      select.value = '2001-01';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(q('[role="status"]')!.textContent).toBe(t.jump.empty);
  });

  test('a jump stops after a bounded number of pages and says so', async () => {
    const lib = await createTestLibrary();
    const total = (JUMP_PAGES_MAX + 2) * PHOTO_PAGE_SIZE;
    const items: NewPhotoItem[] = [];
    for (let i = 0; i < total; i++) items.push(item(1, { sha256: `${'0'.repeat(56)}${i.toString(16).padStart(8, '0')}`, fileName: `${i}.jpg`, takenAt: i < total - 5 ? '2026-03-13T10:00:00Z' : '2019-07-01T10:00:00Z' }));
    for (let i = 0; i < items.length; i += 2500) await seed(lib, items.slice(i, i + 2500));
    await open(lib);
    const select = q('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '2019-07';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < JUMP_PAGES_MAX + 3; i++) await settle();
    expect(all('[data-photo]').length).toBe(PHOTO_PAGE_SIZE * (JUMP_PAGES_MAX + 1));
    expect(q('[role="status"]')!.textContent).toBe(t.jump.stopped);
  }, 60_000);

  test('the months to jump to follow an assignment', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await person(lib, 'Ana');
    await open(lib);
    const months = () => all('select option').map((o) => (o as HTMLOptionElement).value);
    expect(months()).toContain('2019-07');
    await assignTo(lib, [3]);
    expect(months()).not.toContain('2019-07');
    await click(button(t.result.undo));
    await settle();
    expect(months()).toContain('2019-07');
  });

  test('chosen pictures that left the collection are dropped after a failed assignment, and a retry works', async () => {
    const lib = await createTestLibrary();
    await seed(lib, [item(1)]);
    await seed(lib, [item(2, { takenAt: '2026-03-12T10:00:00Z' })]);
    await person(lib, 'Ana');
    await open(lib);
    await selectMode();
    await click(tile(1));
    await click(tile(2));
    // Another tab took picture 1 out of the collection (its import was undone).
    await lib.client.call('undoPhotoBatch', { batchId: uuid(0x500 + batchNo - 1) });
    await click(button(t.assignButton));
    await settle();
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('may not have been assigned');
    expect(q('[role="status"]')!.textContent).toContain('1 of the chosen pictures is no longer in the collection');
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('1 picture selected');
    expect(q(`[data-photo="${hash(1)}"]`)).toBeNull();
    await click(button(t.assignButton));
    await settle();
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('1 assignment added.');
  });

  test('undo takes back exactly what this assignment added, even if another tab assigned one of the pictures first', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    const ana = await person(lib, 'Ana');
    await open(lib);
    await selectMode();
    await click(tile(1));
    await click(tile(2));
    // Another tab gives picture 1 to Ana after this tab drew it as unassigned.
    await lib.client.call('assignPhotos', { sha256s: [hash(1)], profileIds: [ana.id], now: '2026-03-01T10:00:00Z' });
    await click(button(t.assignButton));
    await settle();
    await click(q('dialog[aria-labelledby="assign-title"] input[type="checkbox"]'));
    await click(button(t.assign.next));
    await click(button(t.assign.confirm, q('dialog[aria-labelledby="assign-title"]')!));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('1 assignment added.');
    await click(button(t.result.undo));
    await settle();
    const kept = await lib.client.call('listPhotoPictures', { scope: { show: 'assigned' }, limit: 10 });
    expect(kept.pictures.map((p) => p.sha256)).toEqual([hash(1)]);
  });

  test('a failed undo changes nothing, keeps the assignment on screen and can be repeated', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await person(lib, 'Ana');
    await open(lib);
    await assignTo(lib, [1, 2]);
    const spy = failCalls(lib, 'unassignPhotoLinks', 1);
    await click(button(t.result.undo));
    await settle();
    expect(q('[data-testid="undo-failed"]')!.textContent).toBe(t.result.undoFailed);
    expect((await lib.client.call('countPhotoPictures')).unassigned).toBe(3);
    await click(button(t.result.undo));
    await settle();
    expect(q('[data-testid="select-result"]')!.textContent).toContain('2 assignments were taken back.');
    expect((await lib.client.call('countPhotoPictures')).unassigned).toBe(5);
    spy.mockRestore();
  });

  test('changing the filter lets the choice go and says so; Select off keeps a long choice and lets a short one go', async () => {
    const lib = await createTestLibrary();
    await seed(lib, Array.from({ length: 25 }, (_, i) => item(i + 1, { takenAt: `2026-03-13T10:${String(i).padStart(2, '0')}:00Z` })));
    await open(lib);
    await selectMode();
    await click(tile(1));
    await click(button(/^All/));
    await settle();
    expect(q('[data-testid="select-bar"]')).toBeNull();
    expect(q('[role="status"]')!.textContent).toBe(t.selectionCleared);
    // A long choice survives turning Select off.
    await key(tile(2), 'a', { ctrlKey: true });
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('25 pictures selected');
    await selectMode();
    expect(q('[data-testid="select-bar"]')!.textContent).toContain('25 pictures selected');
    expect(q('[role="status"]')!.textContent).toContain('still chosen');
    await click(button(t.clear));
    // A short one goes with it.
    await selectMode();
    await click(tile(1));
    await selectMode();
    expect(q('[data-testid="select-bar"]')).toBeNull();
  });

  test('a photo with no thumbnail and too big to show as it is gets a placeholder, not its full file', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const lib = await createTestLibrary();
    const info = await lib.deps.blobStore.put(new Uint8Array(THUMB_MIN_SOURCE_BYTES + 10));
    await seed(lib, [item(1, { sha256: info.sha256 })]);
    await open(lib);
    const el = q(`[data-photo="${info.sha256}"]`)!;
    await intersect(el, true);
    await settle();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[data-testid="photo-tile-no-preview"]')!.textContent).toContain('1.jpg');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('a long press that leaves no click behind does not eat the next tap', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    await open(lib);
    const el = tile(1);
    await act(async () => el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
    await act(async () => void (await new Promise((r) => setTimeout(r, 650))));
    expect(el.getAttribute('aria-selected')).toBe('true');
    await act(async () => el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true })));
    await act(async () => void (await new Promise((r) => setTimeout(r, 450))));
    await click(el); // a real tap: Select is on, so it unchooses
    expect(el.getAttribute('aria-selected')).toBe('false');
  });

  test('Take out moves focus to the next person; closing a detail whose tile left the list focuses the heading', async () => {
    const lib = await createTestLibrary();
    await seed(lib, FIVE());
    const ana = await person(lib, 'Ana');
    const bru = await person(lib, 'Bru');
    await lib.client.call('assignPhotos', { sha256s: [hash(1)], profileIds: [ana.id, bru.id], now: '2026-03-01T10:00:00Z' });
    await open(lib);
    await click(button(/^Assigned/));
    await settle();
    await click(tile(1));
    const detail = q('dialog[aria-label]')!;
    const take = () => [...detail.querySelectorAll<HTMLElement>('[data-testid="detail-people"] button')];
    expect(take()).toHaveLength(2);
    await click(take()[0]);
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(take()).toHaveLength(1);
    expect(document.activeElement).toBe(take()[0]);
    await click(take()[0]);
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    // Its last person left: the picture left the Assigned list and the detail closed.
    expect(q(`[data-photo="${hash(1)}"]`)).toBeNull();
    expect(detail.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(q('h1'));
  });
});
