import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { PersonGalleryScreen } from './person-gallery-screen';

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

/** An IntersectionObserver the test drives: tiles are "far" until `show` says otherwise. */
const observers = new Set<{ element: Element; callback: IntersectionObserverCallback; active: boolean }>();
class FakeObserver {
  private entry?: { element: Element; callback: IntersectionObserverCallback; active: boolean };
  constructor(private callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    this.entry = { element, callback: this.callback, active: true };
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

const t = en.personGallery;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-04-01T12:00:00Z';
const PRIVATE = uuid(0x20);
const GROUP = uuid(0x21);
const GONE = 'ee'.repeat(32);
const HOSTILE = '<img src=x onerror="window.__pwned=1">.mp4';

let counter = 0;
const media = (type: NewMessage['type'], sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: (++counter).toString(16).padStart(64, '0'),
  sentAt,
  ordinal: 0,
  type,
  participantName: 'Ana',
  body: '',
  mediaSha256: null,
  mediaName: 'IMG.jpg',
  ...over,
});

async function load(lib: Lib, conversationId: string, sourceKey: string, title: string, personId: string, messages: NewMessage[], blobs: Array<{ sha256: string; size: number; mime: string | null }>) {
  await lib.client.call('importMessages', {
    batchId: uuid(0x100 + counter),
    conversationId,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs,
    messages,
    newConversation: { title, sourceKey, isGroup: false, profileIds: [personId] },
    meAuthor: 'Ana',
  });
}

/** Ana's gallery: a photo and a video (hostile name) in January, a photo in February, a missing photo in March; stickers and audio are not part of it. */
async function seed(lib: Lib, extra = 0) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  const { sha256 } = await lib.deps.blobStore.put(new Uint8Array([1, 2, 3]));
  const blobs = [
    { sha256, size: 3, mime: 'image/jpeg' },
    { sha256: GONE, size: 3, mime: 'image/jpeg' },
  ];
  await load(lib, PRIVATE, 'p', 'Chat with Ana', ana.id, [
    media('photo', '2026-01-10T09:05:00', { mediaSha256: sha256 }),
    media('video', '2026-01-11T10:00:00', { mediaSha256: sha256, mediaName: HOSTILE }),
    media('sticker', '2026-01-12T10:00:00', { mediaSha256: sha256 }),
    media('audio', '2026-01-13T10:00:00', { mediaSha256: sha256 }),
    media('photo', '2026-02-11T21:30:00', { mediaSha256: sha256, participantName: 'Bo' }),
    ...Array.from({ length: extra }, (_, i) => media('photo', `2026-02-13T10:${String(i).padStart(2, '0')}:00`, { mediaSha256: sha256 })),
  ], blobs);
  await load(lib, GROUP, 'g', 'Family group', ana.id, [media('photo', '2026-03-14T18:00:00', { mediaSha256: GONE })], blobs);
  return ana;
}

let view: View | undefined;
async function open(prepare: (lib: Lib) => Promise<{ id: string }>, query?: (id: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const person = await prepare(lib);
  search = query ? query(person.id) : `id=${person.id}`;
  view = await renderWithLibrary(<PersonGalleryScreen />, { lib, messages });
  await settle();
  return { view, lib, person };
}

const click = (el: Element) => act(async () => (el as HTMLElement).click());
const tiles = () => [...view!.container.querySelectorAll('section li button')];
const text = () => view!.container.textContent ?? '';
const watched = (tile: Element) => [...observers].map((o) => o.element).find((el) => tile.contains(el) || el.parentElement === tile);

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  observers.clear();
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('PersonGalleryScreen', () => {
  test('lists the photos and videos (not stickers or audio), oldest first, by month, and reads nothing yet', async () => {
    const { person } = await open(seed);
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(text()).toContain('4 photos and videos');
    expect([...view!.container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['January 2026', 'February 2026', 'March 2026']);
    expect(tiles().map((a) => a.getAttribute('aria-label'))).toEqual([
      'View Photo, Jan 10, 2026, 9:05 AM, from “Chat with Ana”',
      'View Video, Jan 11, 2026, 10:00 AM, from “Chat with Ana”',
      'View Photo, Feb 11, 2026, 9:30 PM, from “Chat with Ana”',
      'View Photo, Mar 14, 2026, 6:00 PM, from “Family group”',
    ]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(view!.container.querySelector('img')).toBeNull();
    expect(view!.container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(`/person/gallery?id=${person.id}`);
    expect(view!.container.querySelector(`a[href="/person?id=${person.id}"]`)?.textContent).toBe('Back to Ana');
  });

  test('a photo is read only while its tile is near the screen, and freed when it leaves', async () => {
    await open(seed);
    const photo = watched(tiles()[0])!;
    expect(photo).toBeDefined();
    await intersect(photo, true);
    await settle();
    const img = tiles()[0].querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:mock-1');
    expect(img.getAttribute('alt')).toBe('');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await intersect(photo, false);
    await settle();
    expect(tiles()[0].querySelector('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    // a tile that was never near never read anything
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('a video tile shows a play glyph and its file name as text, and reads nothing', async () => {
    await open(seed);
    const video = tiles()[1];
    expect(video.textContent).toBe(HOSTILE);
    expect(video.querySelector('svg')).not.toBeNull();
    expect(video.querySelector('img, video')).toBeNull();
    expect(watched(video)).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('a file the archive does not have is a calm note inside its tile', async () => {
    await open(seed);
    await intersect(watched(tiles()[3])!, true);
    await settle();
    expect(tiles()[3].textContent).toBe(en.conversation.media.missing);
    expect(tiles()[3].querySelector('img')).toBeNull();
  });

  test('a picture the browser cannot show falls back to the same note', async () => {
    await open(seed);
    await intersect(watched(tiles()[0])!, true);
    await settle();
    await act(async () => tiles()[0].querySelector('img')!.dispatchEvent(new Event('error')));
    expect(tiles()[0].querySelector('img')).toBeNull();
    expect(tiles()[0].textContent).toBe(en.conversation.media.error);
  });

  test('50 at a time: Show more adds the next ones and the count says how many are shown', async () => {
    await open((lib) => seed(lib, 57)); // 61 in all
    expect(tiles()).toHaveLength(50);
    expect(text()).toContain('61 photos and videos');
    expect(text()).toContain('Showing 50 of 61');
    const more = [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.showMore)!;
    expect(more.className).toContain('min-h-11');
    await click(more);
    await settle();
    expect(tiles()).toHaveLength(61);
    expect(text()).not.toContain('Showing');
  });

  test('a person without photos or videos gets a calm empty state', async () => {
    await open((lib) => createProfile(lib.deps, { displayName: 'Bo' }));
    expect(text()).toContain('There are no photos or videos yet in the conversations kept under Bo');
    expect(tiles()).toHaveLength(0);
  });

  test.each([['an id nobody has', () => `id=${uuid(0x99)}`], ['a malformed id', () => 'id=nope'], ['no id', () => '']])('%s is a calm not-found with the way back', async (_name, query) => {
    await open(seed, query);
    expect(view!.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
    expect(view!.container.querySelector('a[href="/people"]')).not.toBeNull();
  });

  test('a failed read says nothing was deleted and Try again reads it again', async () => {
    const { lib } = await open(seed, undefined);
    view!.unmount();
    const call = lib.deps.client.call.bind(lib.deps.client);
    let fail = true;
    (lib.deps.client as { call: unknown }).call = (op: string, ...args: unknown[]) =>
      fail && op === 'listPersonMedia' ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => Promise<unknown>)(op, ...args);
    view = await renderWithLibrary(<PersonGalleryScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(t.loadFailed);
    fail = false;
    await click(view.container.querySelector('[role="alert"] button')!);
    await settle();
    expect(tiles()).toHaveLength(4);
  });

  test('speaks Catalan', async () => {
    await open(seed, undefined, ca);
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.personGallery.title);
    expect(tiles()[0].getAttribute('aria-label')).toContain('Mostra Foto,');
  });
});
