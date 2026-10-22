import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
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
  usePathname: () => '/sub',
}));

// happy-dom has no modal <dialog>: a local stand-in that toggles `open` and fires `close`.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

class QuietObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const t = en.personGallery;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PRIVATE = uuid(0x20);
const GONE = 'ee'.repeat(32);
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

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

/** A photo (author with a hostile name), a video, a missing photo, then `extra` photos: 3 + extra in all. */
async function seed(lib: Lib, extra = 0) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  const { sha256 } = await lib.deps.blobStore.put(new Uint8Array([1, 2, 3]));
  const blobs = [
    { sha256, size: 3, mime: 'image/jpeg' },
    { sha256: GONE, size: 3, mime: 'image/jpeg' },
  ];
  await lib.client.call('importMessages', {
    batchId: uuid(0x100),
    conversationId: PRIVATE,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: '2026-04-01T12:00:00Z',
    blobs,
    messages: [
      media('photo', '2026-01-10T09:05:00', { mediaSha256: sha256, participantName: HOSTILE, body: 'On the beach' }),
      media('video', '2026-01-11T10:00:00', { mediaSha256: sha256, mediaName: 'clip.mp4' }),
      media('photo', '2026-01-12T10:00:00', { mediaSha256: GONE }),
      ...Array.from({ length: extra }, (_, i) => media('photo', `2026-02-13T10:${String(i).padStart(2, '0')}:00`, { mediaSha256: sha256 })),
    ],
    newConversation: { title: 'Chat with Ana', sourceKey: 'p', isGroup: false, profileIds: [ana.id] },
    meAuthor: 'Ana',
  });
  return ana;
}

let view: Rendered | undefined;
async function open(extra = 0, prepare?: (lib: Lib) => void) {
  const lib = await createTestLibrary();
  const person = await seed(lib, extra);
  prepare?.(lib);
  search = `id=${person.id}`;
  view = await renderWithLibrary(<PersonGalleryScreen />, { lib });
  await settle();
  return { person, lib };
}

const q = (selector: string) => view!.container.querySelector(selector);
const tiles = () => [...view!.container.querySelectorAll<HTMLButtonElement>('section li button')];
const dialog = () => q('dialog[open]') as HTMLDialogElement | null;
const press = (key: string, target: Element) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (name: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!;
const position = () => dialog()!.querySelector('[role="status"]')?.textContent;
const openTile = async (n: number) => {
  await click(tiles()[n]);
  await settle();
};

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('IntersectionObserver', QuietObserver);
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('PersonGalleryLightbox', () => {
  test('a tile opens a modal dialog with the photo full size, its text and a link to the conversation', async () => {
    const { person } = await open();
    expect(dialog()).toBeNull();
    await openTile(0);
    const d = dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Photo from “Chat with Ana”, Jan 10, 2026, 9:05 AM');
    const img = d.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:mock-1');
    expect(img.getAttribute('alt')).toBe('IMG.jpg');
    expect(d.querySelector('h2')?.textContent).toBe('Chat with Ana');
    expect(d.textContent).toContain('On the beach');
    // hostile author is text, never markup
    expect(d.textContent).toContain(HOSTILE);
    expect(d.querySelector('h2 ~ p img')).toBeNull();
    expect(d.querySelector('[dir="auto"]')).not.toBeNull();
    expect(d.querySelector('a')?.getAttribute('href')).toBe(`/conversation?id=${PRIVATE}&from=${person.id}&date=2026-01-10`);
    expect(d.querySelector('a')?.textContent).toBe(t.openInConversation);
    expect(position()).toBe('1 of 3');
  });

  test('Next, Previous and the arrow keys walk the items; the ends are disabled; the video is the only video', async () => {
    await open();
    await openTile(0);
    expect(button(t.previous).getAttribute('aria-disabled')).toBe('true');
    await click(button(t.next));
    await settle();
    expect(position()).toBe('2 of 3');
    expect(dialog()!.querySelector('video')?.getAttribute('src')).toBe('blob:mock-2');
    expect(dialog()!.querySelector('video')?.hasAttribute('controls')).toBe(true);
    expect(dialog()!.querySelector('img')).toBeNull();
    // arrows inside the video's own controls are left to the video
    await press('ArrowRight', dialog()!.querySelector('video')!);
    expect(position()).toBe('2 of 3');
    await press('ArrowRight', dialog()!);
    await settle();
    expect(position()).toBe('3 of 3');
    expect(dialog()!.querySelector('video')).toBeNull();
    expect(button(t.next).getAttribute('aria-disabled')).toBe('true');
    await press('ArrowRight', dialog()!);
    expect(position()).toBe('3 of 3');
    await press('ArrowLeft', dialog()!);
    await settle();
    expect(position()).toBe('2 of 3');
  });

  test('a file the archive does not have is a calm note', async () => {
    await open();
    await openTile(2);
    expect(dialog()!.textContent).toContain(en.conversation.media.missing);
    expect(dialog()!.querySelector('img, video')).toBeNull();
  });

  test('moving on frees the previous photo', async () => {
    await open();
    await openTile(0);
    await click(button(t.next));
    await settle();
    // the first photo's URL is no longer held
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  test('only the open item and the next photo hold a file, and closing frees them all', async () => {
    await open(3);
    await openTile(0);
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    await settle();
    // item 1 (photo) is open; item 2 is a video, so nothing else is preloaded
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await click(button(t.close));
    expect(dialog()).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  test('when the browser is idle the next photo is read ahead, and becomes the open one without a second read', async () => {
    await open(3);
    await openTile(3);
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    await settle();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await click(button(t.next));
    await settle();
    expect(dialog()!.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  test('Close and Escape close it and focus returns to the tile; the position is announced politely', async () => {
    await open();
    const first = tiles()[0];
    first.focus();
    await openTile(0);
    expect(dialog()!.querySelector('[role="status"]')).not.toBeNull();
    await click(button(t.close));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(first);
    // Escape: the dialog fires cancel
    await openTile(1);
    await act(async () => void dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(dialog()).toBeNull();
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(document.activeElement).toBe(tiles()[1]);
  });

  test('at the last loaded item Next loads the next page and moves on when it arrives', async () => {
    await open(57); // 60 in all, 50 loaded
    await openTile(49);
    expect(position()).toBe('50 of 50');
    expect(button(t.next).getAttribute('aria-disabled')).toBeNull();
    await click(button(t.next));
    await settle();
    expect(position()).toBe('51 of 60');
  });

  test('when the next page cannot be read it stays put and says so', async () => {
    const { lib } = await open(57);
    const call = lib.deps.client.call.bind(lib.deps.client);
    (lib.deps.client as { call: unknown }).call = (op: string, ...args: unknown[]) =>
      op === 'listPersonMedia' && (args[0] as { offset?: number })?.offset ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => Promise<unknown>)(op, ...args);
    await openTile(49);
    await click(button(t.next));
    await settle();
    expect(position()).toBe('50 of 50');
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(t.moreFailed);
  });
});
