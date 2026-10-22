import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage } from '@/lib/domain/library';
import { PERSON_FAVORITES_PAGE } from '@/hooks/use-person-favorites';
import { countFavorites, setFavorite } from '@/lib/usecases/favorites';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { PersonFavoritesScreen } from './person-favorites-screen';

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
const t = en.personFavorites;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PRIVATE = uuid(0x20);
const GROUP = uuid(0x21);
const SHA = 'ab'.repeat(32);
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

let counter = 0;
const msg = (sentAt: string, over: Partial<NewMessage> = {}): NewMessage => ({
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
    now: '2026-04-01T12:00:00Z',
    blobs: [{ sha256: SHA, size: 1, mime: 'image/jpeg' }],
    messages,
    newConversation: { title, sourceKey: conversationId, isGroup: false, profileIds: [personId] },
    meAuthor: 'Ana',
  });
}

async function star(lib: Lib, conversationId: string, bodies: string[]) {
  const rows = await lib.client.call('getMessageWindow', { conversationId, offset: 0, limit: 1000 });
  for (const row of rows.filter((r) => bodies.includes(r.body) || (bodies.includes('*photo') && r.type === 'photo'))) await setFavorite(lib.deps, conversationId, row.id, true);
}

/** Ana's chat (Feb) and group (Mar) with four starred messages in all, one a photo, one hostile text. */
async function seed(lib: Lib) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  await load(lib, PRIVATE, 'Chat with Ana', ana.id, [
    msg('2026-02-11T21:30:00', { body: HOSTILE, participantName: 'Bo' }),
    msg('2026-02-12T08:00:00', { body: 'not starred' }),
    msg('2026-02-13T08:00:00', { type: 'photo', mediaSha256: SHA, mediaName: 'IMG-1.jpg', body: 'on the beach' }),
  ]);
  await load(lib, GROUP, 'Family group', ana.id, [msg('2026-03-14T18:00:00', { body: 'from the group', participantName: 'Eve' })]);
  await star(lib, PRIVATE, [HOSTILE, '*photo']);
  await star(lib, GROUP, ['from the group']);
  return ana;
}

let view: (Rendered & { lib: Lib }) | undefined;
async function open(prepare: (lib: Lib) => Promise<{ id: string }>, query?: (id: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const person = await prepare(lib);
  search = query ? query(person.id) : `id=${person.id}`;
  view = await renderWithLibrary(<PersonFavoritesScreen />, { lib, messages });
  await settle();
  return { lib, person };
}

const items = () => [...view!.container.querySelectorAll('section li')];
const text = () => view!.container.textContent ?? '';
const click = (el: Element) => act(async () => (el as HTMLElement).click());

beforeEach(() => {
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('PersonFavoritesScreen', () => {
  test('lists the favorites of every conversation, oldest first, by month, as text; reads no file', async () => {
    const { person } = await open(seed);
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(text()).toContain('3 favorite messages');
    expect([...view!.container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['February 2026', 'March 2026']);
    const [first, photo, group] = items();
    expect(first.textContent).toContain('Feb 11, 2026, 9:30 PM');
    expect(first.textContent).toContain('Chat with Ana');
    expect(first.textContent).toContain('Bo');
    expect(first.textContent).toContain(HOSTILE);
    expect(view!.container.querySelector('img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(photo.textContent).toContain('Photo · IMG-1.jpg');
    expect(photo.textContent).toContain('on the beach');
    expect(photo.textContent).toContain(t.you);
    expect(group.textContent).toContain('Family group');
    expect(text()).not.toContain('not starred');
    expect(view!.container.querySelector('a[href="/person?id=' + person.id + '"]')?.textContent).toBe('Back to Ana');
  });

  test('"Open in conversation" goes to that message\'s day, coming from the person', async () => {
    const { person } = await open(seed);
    const links = [...view!.container.querySelectorAll('section li a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      `/conversation?id=${PRIVATE}&from=${person.id}&date=2026-02-11`,
      `/conversation?id=${PRIVATE}&from=${person.id}&date=2026-02-13`,
      `/conversation?id=${GROUP}&from=${person.id}&date=2026-03-14`,
    ]);
  });

  test('the star removes the favorite: it leaves the list, the count follows, a calm note is announced, the message stays', async () => {
    const { lib } = await open(seed);
    const button = items()[0].querySelector<HTMLButtonElement>('button')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe(t.remove);
    expect(button.className).toContain('size-11');
    await click(button);
    await settle();
    expect(items()).toHaveLength(2);
    expect(text()).toContain('2 favorite messages');
    expect([...view!.container.querySelectorAll('[role="status"]')].map((n) => n.textContent)).toContain(t.removed);
    expect(await countFavorites(lib.deps)).toBe(2);
    const rows = await lib.client.call('getMessageWindow', { conversationId: PRIVATE, offset: 0, limit: 10 });
    expect(rows.map((r) => r.body)).toContain(HOSTILE);
  });

  test('a failed removal keeps the item and says so as an alert', async () => {
    const { lib } = await open(seed);
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setFavorite' ? Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) : call(method, params));
    await click(items()[0].querySelector('button')!);
    await settle();
    expect(items()).toHaveLength(3);
    expect(view!.container.querySelector('[role="alert"]')!.textContent).toBe(t.removeFailed);
  });

  test('empty: says there are none and how to add one', async () => {
    await open(async (lib) => createProfile(lib.deps, { displayName: 'Ana' }));
    expect(items()).toHaveLength(0);
    expect(text()).toContain('Ana has no favorite messages yet.');
    expect(text()).toContain(t.emptyHint);
  });

  test('50 at a time with Show more; removing one does not skip any', async () => {
    const { lib } = await open(async (l) => {
      const ana = await createProfile(l.deps, { displayName: 'Ana' });
      await load(l, PRIVATE, 'Chat', ana.id, Array.from({ length: PERSON_FAVORITES_PAGE + 3 }, (_, i) => msg(`2026-02-01T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, { body: `n${i}` })));
      await star(l, PRIVATE, Array.from({ length: PERSON_FAVORITES_PAGE + 3 }, (_, i) => `n${i}`));
      return ana;
    });
    expect(items()).toHaveLength(PERSON_FAVORITES_PAGE);
    expect(text()).toContain(`Showing ${PERSON_FAVORITES_PAGE} of ${PERSON_FAVORITES_PAGE + 3}`);
    await click(items()[0].querySelector('button')!);
    await settle();
    await click([...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.showMore)!);
    await settle();
    expect(items()).toHaveLength(PERSON_FAVORITES_PAGE + 2);
    expect(text()).not.toContain('Show more');
    expect(new Set(items().map((i) => i.textContent)).size).toBe(PERSON_FAVORITES_PAGE + 2);
  });

  test('loading, error with Retry, and not-found are calm states', async () => {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    search = `id=${ana.id}`;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    let fail = true;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) =>
      fail && method === 'listFavorites' ? Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) : call(method, params);
    view = await renderWithLibrary(<PersonFavoritesScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain(t.loadFailed);
    fail = false;
    await click([...view.container.querySelectorAll('button')].find((b) => b.textContent === en.library.retry)!);
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe(t.title);
    view.unmount();

    search = `id=${uuid(0xff)}`;
    view = await renderWithLibrary(<PersonFavoritesScreen />, { lib });
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
  });

  test('is translated', async () => {
    await open(seed, undefined, ca);
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.personFavorites.title);
  });
});
