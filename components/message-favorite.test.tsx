import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage } from '@/lib/domain/library';
import { countFavorites } from '@/lib/usecases/favorites';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { ConversationScreen } from './conversation-screen';
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
}));

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const f = en.conversation.favorite;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CHAT = uuid(0x20);
const GROUP = uuid(0x21);

let counter = 0;
const msg = (over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: (++counter).toString(16).padStart(64, '0'),
  sentAt: `2026-03-17T10:${String(counter).padStart(2, '0')}:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Bo',
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
    blobs: [],
    messages,
    newConversation: { title, sourceKey: conversationId, isGroup: false, profileIds: [personId] },
  });
}

let view: (Rendered & { lib: Lib }) | undefined;
async function open(ui: React.ReactNode, query: (personId: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
  await load(lib, CHAT, 'Chat', ana.id, [msg(), msg({ type: 'system', participantName: null, body: 'Messages are encrypted' }), msg({ type: 'deleted', body: '' }), msg()]);
  await load(lib, GROUP, 'Group', ana.id, [msg({ sentAt: '2026-03-18T09:00:00' })]);
  search = query(ana.id);
  view = await renderWithLibrary(ui, { lib, messages });
  await settle();
  return lib;
}

const feed = () => view!.container.querySelector<HTMLElement>('[role="feed"]')!;
const articles = () => [...feed().querySelectorAll<HTMLElement>('article')];
const star = (article: HTMLElement) => article.querySelector<HTMLButtonElement>('button[aria-pressed]');
const click = (el: Element) => act(async () => (el as HTMLElement).click());

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.getAttribute('role') === 'feed' ? 600 : 0; } });
  counter = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  sessionStorage.clear();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('the star on a message', () => {
  test('is a 44 px toggle beside Details on messages only, never on system or deleted notices', async () => {
    await open(<ConversationScreen />, () => `id=${CHAT}`);
    const [first, system, deleted, last] = articles();
    for (const article of [first, last]) {
      const button = star(article)!;
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.getAttribute('aria-label')).toBe(f.add);
      expect(button.className).toContain('size-11');
      expect(button.parentElement!.querySelector(`button[aria-label="${en.conversation.details.toggle}"]`)).not.toBeNull();
    }
    expect(star(system)).toBeNull();
    expect(star(deleted)).toBeNull();
  });

  test('pressing it marks the message at once, stores it, keeps every row where it was, and pressing again clears it', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const tops = articles().map((a) => a.style.transform);
    await click(star(articles()[0])!);
    expect(star(articles()[0])!.getAttribute('aria-pressed')).toBe('true');
    expect(star(articles()[0])!.getAttribute('aria-label')).toBe(f.remove);
    expect(star(articles()[3])!.getAttribute('aria-pressed')).toBe('false');
    expect(articles().map((a) => a.style.transform)).toEqual(tops);
    await settle();
    expect(await countFavorites(lib.deps, { conversationId: CHAT })).toBe(1);
    await click(star(articles()[0])!);
    await settle();
    expect(star(articles()[0])!.getAttribute('aria-pressed')).toBe('false');
    expect(await countFavorites(lib.deps, { conversationId: CHAT })).toBe(0);
  });

  test('a message that is already a favorite opens marked', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    await click(star(articles()[0])!);
    await settle();
    view!.unmount();
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    expect(star(articles()[0])!.getAttribute('aria-pressed')).toBe('true');
  });

  test('a failed write rolls the star back and says so in the live region; nothing is lost', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setFavorite' ? Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) : call(method, params));
    await click(star(articles()[0])!);
    await settle();
    expect(star(articles()[0])!.getAttribute('aria-pressed')).toBe('false');
    expect(view!.container.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe(f.failed);
  });

  test('on a person timeline the star saves in the message\'s own conversation', async () => {
    const lib = await open(<PersonTimelineScreen />, (id) => `id=${id}&date=2026-03-17`);
    const rows = articles();
    expect(rows).toHaveLength(5);
    await click(star(rows[4])!); // the group's message
    await settle();
    expect(await countFavorites(lib.deps, { conversationId: GROUP })).toBe(1);
    expect(await countFavorites(lib.deps, { conversationId: CHAT })).toBe(0);
    expect(star(articles()[4])!.getAttribute('aria-pressed')).toBe('true');
    expect(star(articles()[0])!.getAttribute('aria-pressed')).toBe('false');
  });

  test('the names are translated', async () => {
    await open(<ConversationScreen />, () => `id=${CHAT}`, ca);
    expect(star(articles()[0])!.getAttribute('aria-label')).toBe(ca.conversation.favorite.add);
  });
});
