import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { PersonAudioScreen } from './person-audio-screen';

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

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
type View = Rendered & Awaited<ReturnType<typeof renderWithLibrary>>;

const t = en.personAudio;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-04-01T12:00:00Z';
const PRIVATE = uuid(0x20);
const GROUP = uuid(0x21);
const GONE = 'ee'.repeat(32);
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

let counter = 0;
const audio = (sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: (++counter).toString(16).padStart(64, '0'),
  sentAt,
  ordinal: 0,
  type: 'audio',
  participantName: 'Ana',
  body: '',
  mediaSha256: null,
  mediaName: 'PTT.opus',
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

/** Ana's audio: January and February in a private chat (the second from "me"), March in a group, one file missing. */
async function seed(lib: Lib, extra = 0) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  const { sha256 } = await lib.deps.blobStore.put(new Uint8Array([1, 2, 3]));
  const blobs = [
    { sha256, size: 3, mime: 'audio/ogg' },
    { sha256: GONE, size: 3, mime: 'audio/ogg' },
  ];
  await load(lib, PRIVATE, 'p', 'Chat with Ana', ana.id, [
    audio('2026-01-10T09:05:00', { mediaSha256: sha256, body: HOSTILE }),
    audio('2026-02-11T21:30:00', { mediaSha256: sha256, participantName: 'Bo', mediaName: '' }),
    { ...audio('2026-02-12T08:00:00'), type: 'text', body: 'no file here' },
    ...Array.from({ length: extra }, (_, i) => audio(`2026-02-13T10:${String(i).padStart(2, '0')}:00`, { mediaSha256: sha256 })),
  ], blobs);
  await load(lib, GROUP, 'g', 'Family group', ana.id, [audio('2026-03-14T18:00:00', { mediaSha256: GONE, participantName: 'Eve' })], blobs);
  return ana;
}

let view: View | undefined;
async function open(prepare: (lib: Lib) => Promise<{ id: string }>, query?: (id: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const person = await prepare(lib);
  search = query ? query(person.id) : `id=${person.id}`;
  view = await renderWithLibrary(<PersonAudioScreen />, { lib, messages });
  await settle();
  return { view, lib, person };
}

const click = (el: Element) => act(async () => (el as HTMLElement).click());
const items = () => [...view!.container.querySelectorAll('section li')];
const playButtons = () => [...view!.container.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === t.play);
const players = () => view!.container.querySelectorAll('audio');
const text = () => view!.container.textContent ?? '';

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  URL.revokeObjectURL = vi.fn();
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('PersonAudioScreen', () => {
  test('lists every voice message of the person, oldest first, by month, and reads no file yet', async () => {
    const { person } = await open(seed);
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(text()).toContain('3 voice messages and audio files');
    expect([...view!.container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['January 2026', 'February 2026', 'March 2026']);
    expect(items()).toHaveLength(3);
    const [first, second, third] = items();
    expect(first.textContent).toContain('Jan 10, 2026, 9:05 AM');
    expect(first.textContent).toContain('Chat with Ana');
    expect(second.textContent).toContain('Feb 11, 2026, 9:30 PM');
    expect(second.textContent).toContain('Bo');
    expect(third.textContent).toContain('Family group');
    expect(third.textContent).toContain('Eve');
    // "me" is named as such
    expect(first.textContent).toContain(t.you);
    // a caption is text, never markup
    expect(first.textContent).toContain(HOSTILE);
    expect(view!.container.querySelector('img')).toBeNull();
    // nothing is read until a player is asked for
    expect(players()).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    // back to the person; sections with the current one marked
    expect(view!.container.querySelector(`a[href="/person?id=${person.id}"]`)?.textContent).toBe('Back to Ana');
    expect(view!.container.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(`/person/audio?id=${person.id}`);
  });

  test('each item opens its message in its conversation, on that day, coming from the person', async () => {
    const { person } = await open(seed);
    const links = [...view!.container.querySelectorAll('section li a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      `/conversation?id=${PRIVATE}&from=${person.id}&date=2026-01-10`,
      `/conversation?id=${PRIVATE}&from=${person.id}&date=2026-02-11`,
      `/conversation?id=${GROUP}&from=${person.id}&date=2026-03-14`,
    ]);
    const link = view!.container.querySelector('section li a')!;
    expect(link.textContent).toBe(t.open);
    expect(link.getAttribute('aria-label')).toBe('Open in conversation “Chat with Ana”, Jan 10, 2026, 9:05 AM');
  });

  test('Play reads that one file; starting another one stops the first (one at a time) and frees it', async () => {
    await open(seed);
    await click(playButtons()[0]);
    await settle();
    expect(players()).toHaveLength(1);
    expect(players()[0].getAttribute('src')).toBe('blob:mock-1');
    expect(players()[0].hasAttribute('controls')).toBe(true);
    expect(players()[0].getAttribute('aria-label')).toBe('You, Jan 10, 2026, 9:05 AM');
    expect(items()[0].contains(players()[0])).toBe(true);
    expect(document.activeElement).toBe(players()[0]);

    await click(playButtons()[0]); // the second item (the first now shows a player)
    await settle();
    expect(players()).toHaveLength(1);
    expect(items()[1].contains(players()[0])).toBe(true);
    expect(items()[0].querySelector('button')?.textContent).toBe(t.play);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  test('a file the archive does not have is a calm note, not an error screen', async () => {
    await open(seed);
    await click(items()[2].querySelector('button')!);
    await settle();
    expect(items()[2].querySelector('[role="note"]')?.textContent).toBe(en.conversation.media.missing);
    expect(players()).toHaveLength(0);
  });

  test('50 at a time: Show more adds the next ones and the count says how many are shown', async () => {
    await open((lib) => seed(lib, 57)); // 60 in all
    expect(items()).toHaveLength(50);
    expect(text()).toContain('60 voice messages and audio files');
    expect(text()).toContain('Showing 50 of 60');
    const more = [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.showMore)!;
    expect(more.className).toContain('min-h-11');
    await click(more);
    await settle();
    expect(items()).toHaveLength(60);
    expect(text()).not.toContain('Showing');
    expect([...view!.container.querySelectorAll('button')].some((b) => b.textContent === t.showMore)).toBe(false);
  });

  test('a person without voice messages gets a calm empty state', async () => {
    await open((lib) => createProfile(lib.deps, { displayName: 'Bo' }));
    expect(text()).toContain('There are no voice messages yet in the conversations kept under Bo');
    expect(items()).toHaveLength(0);
    expect(view!.container.querySelector('nav a[aria-current="page"]')).not.toBeNull();
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
    view = await renderWithLibrary(<PersonAudioScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(t.loadFailed);
    fail = false;
    await click(view.container.querySelector('[role="alert"] button')!);
    await settle();
    expect(items()).toHaveLength(3);
  });

  test('speaks Catalan', async () => {
    await open(seed, undefined, ca);
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.personAudio.title);
    expect(view!.container.querySelector('section li a')?.textContent).toBe(ca.personAudio.open);
    expect(view!.container.querySelector('section li button')?.textContent).toBe(ca.personAudio.play);
  });
});
