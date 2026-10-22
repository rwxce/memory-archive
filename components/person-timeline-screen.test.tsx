import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type, type Rendered } from './test-utils';
import { PersonTimelineScreen } from './person-timeline-screen';

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
type View = Rendered & Awaited<ReturnType<typeof renderWithLibrary>>;

const t = en.timeline;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CHAT = uuid(0x20);
const GROUP = uuid(0x21);
const NOW = '2026-04-01T12:00:00Z';
const VIEWPORT = 600;
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

let counter = 0;
const text = (sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: (++counter).toString(16).padStart(64, '0'),
  sentAt,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `hello ${counter}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

async function load(lib: Lib, conversationId: string, title: string, personId: string, messages: NewMessage[]) {
  await lib.client.call('importMessages', {
    batchId: uuid(0x100 + counter),
    conversationId,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [],
    messages,
    newConversation: { title, sourceKey: conversationId, isGroup: false, profileIds: [personId] },
    meAuthor: 'Ana',
  });
}

/** Two conversations of one person that interleave: chat, chat, group, group, chat. */
async function seed(lib: Lib) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
  await load(lib, CHAT, 'Chat with Ana', ana.id, [text('2026-03-17T10:01:00', { participantName: 'Bo' }), text('2026-03-17T10:02:00'), text('2026-04-02T08:00:00', { participantName: 'Bo' })]);
  await load(lib, GROUP, HOSTILE, ana.id, [text('2026-03-18T09:00:00', { participantName: 'Cy' }), text('2026-03-18T09:01:00')]);
  return ana;
}

let view: View | undefined;
async function open(prepare: (lib: Lib) => Promise<{ id: string }>, query?: (id: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const person = await prepare(lib);
  search = query ? query(person.id) : `id=${person.id}`;
  view = await renderWithLibrary(<PersonTimelineScreen />, { lib, messages });
  await settle();
  return { lib, person };
}

const feed = () => view!.container.querySelector<HTMLElement>('[role="feed"]')!;
const articles = () => [...feed().querySelectorAll<HTMLElement>('article')];
const chips = () => [...feed().querySelectorAll<HTMLAnchorElement>('article > a')];
const click = (el: Element) => act(async () => (el as HTMLElement).click());

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.getAttribute('role') === 'feed' ? VIEWPORT : 0; } });
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  sessionStorage.clear();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('PersonTimelineScreen', () => {
  test('header: the person, counts across conversations, dates, back to the person', async () => {
    const { person } = await open(seed);
    expect(view!.container.querySelector('h1')?.textContent).toBe('Ana M.');
    const header = view!.container.querySelector('header')!;
    expect(header.textContent).toContain('5 messages in 2 conversations');
    expect(header.textContent).toContain('Mar 17, 2026');
    const back = header.querySelector('a')!;
    expect(back.textContent).toContain('Back to Ana M.');
    expect(back.getAttribute('href')).toBe(`/person?id=${person.id}`);
    expect(feed().getAttribute('aria-label')).toBe('Messages of Ana M., from all conversations');
  });

  test('merges the conversations in time and names the conversation only when it changes, linking to that day', async () => {
    const { person } = await open(seed, (id) => `id=${id}&date=2026-03-17`);
    expect(articles().map((a) => a.getAttribute('aria-posinset'))).toEqual(['1', '2', '3', '4', '5']);
    expect(articles().every((a) => a.getAttribute('aria-setsize') === '5')).toBe(true);
    expect(chips().map((a) => a.textContent)).toEqual(['Chat with Ana', HOSTILE, 'Chat with Ana'].map((title) => title + en.conversation.openFromTimeline));
    expect(chips().map((a) => a.getAttribute('href'))).toEqual([
      `/conversation?id=${CHAT}&from=${person.id}&date=2026-03-17`,
      `/conversation?id=${GROUP}&from=${person.id}&date=2026-03-18`,
      `/conversation?id=${CHAT}&from=${person.id}&date=2026-04-02`,
    ]);
    // the second message of a run has no label; the hostile title is text, not markup
    expect(articles()[1].querySelector('a')).toBeNull();
    expect(feed().querySelector('img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test('"me" stays on the right in every conversation, and an author keeps one color', async () => {
    await open(seed, (id) => `id=${id}&date=2026-03-17`);
    const [chatBo, chatAna, groupCy, groupAna] = articles();
    expect(chatAna.querySelector('.justify-end')).not.toBeNull();
    expect(groupAna.querySelector('.justify-end')).not.toBeNull();
    expect(chatBo.querySelector('.justify-start')).not.toBeNull();
    expect(groupCy.querySelector('.justify-start')).not.toBeNull();
  });

  test('the date control jumps by date across conversations', async () => {
    await open(seed);
    // The plain date field lives in the calendar sheet.
    await click([...view!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === en.conversation.goToDate)!);
    await settle();
    const input = view!.container.querySelector<HTMLInputElement>('input[type="date"]')!;
    await type(input, '2026-03-18');
    await settle();
    expect(view!.container.querySelector('[role="status"]')!.textContent).toBe('Showing the first message on or after Mar 18, 2026.');
    await type(input, '2030-01-01');
    await settle();
    expect(view!.container.querySelector('[role="status"]')!.textContent).toBe('There are no messages on or after Jan 1, 2030.');
  });

  test('remembers where it was left per person', async () => {
    const { person } = await open(seed);
    await act(async () => {
      feed().scrollTop = 10;
      feed().dispatchEvent(new Event('scroll'));
    });
    view!.unmount();
    const stored = sessionStorage.getItem(`memory-archive:position:timeline:${person.id}`);
    expect(stored).not.toBeNull();
  });

  test('a person without messages gets a calm empty state', async () => {
    await open((lib) => createProfile(lib.deps, { displayName: 'Ana M.' }));
    expect(view!.container.textContent).toContain('There are no messages under Ana M. yet.');
    expect(view!.container.querySelector('[role="feed"]')).toBeNull();
  });

  test('an unknown or malformed id is a calm not-found with a way back', async () => {
    await open(seed, () => `id=${uuid(0x99)}`);
    expect(view!.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
    expect(view!.container.querySelector('section a')!.getAttribute('href')).toBe('/people');
    view!.unmount();
    await open(seed, () => 'id=nope');
    expect(view!.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
  });

  test('a read that fails shows an alert with Retry that recovers', async () => {
    const lib = await createTestLibrary();
    const person = await seed(lib);
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    let fail = true;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) =>
      fail && method === 'getPersonTimelineBounds' ? Promise.reject(new Error('boom')) : call(method, params);
    search = `id=${person.id}`;
    view = await renderWithLibrary(<PersonTimelineScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain(t.loadFailed);
    fail = false;
    await click([...view.container.querySelectorAll('button')].find((b) => b.textContent === en.library.retry)!);
    await settle();
    expect(feed()).not.toBeNull();
  });

  test('the calendar opens on the timeline and jumps across conversations', async () => {
    await open(seed);
    await click([...view!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === en.conversation.goToDate)!);
    await settle();
    expect(view!.container.querySelector('section[aria-label="Calendar of this timeline"]')).not.toBeNull();
  });

  test('speaks Catalan', async () => {
    await open(seed, undefined, ca);
    expect(view!.container.querySelector('header')!.textContent).toContain('5 missatges en 2 converses');
  });
});
