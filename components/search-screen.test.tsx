import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewMessage, SearchResult } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { buildSearchIndex, searchMessages } from '@/lib/usecases/search';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { SearchScreen } from './search-screen';

vi.mock('@/lib/usecases/search', async (original) => {
  const real = await original<typeof import('@/lib/usecases/search')>();
  return { ...real, searchMessages: vi.fn(real.searchMessages), buildSearchIndex: vi.fn(real.buildSearchIndex) };
});

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
const t = en.search;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PRIVATE = uuid(0x20);
const GROUP = uuid(0x21);
const HOSTILE = '<img src=x onerror="window.__pwned=1"> la <b>cançó</b>';

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
    blobs: [],
    messages,
    newConversation: { title, sourceKey: conversationId, isGroup: false, profileIds: [personId] },
    meAuthor: 'Ana',
  });
}

/** Ana: a chat (a hostile message with an accented word, a plain one) and a group (one more match). */
async function seed(lib: Lib) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  const bo = await createProfile(lib.deps, { displayName: 'Bo' });
  await load(lib, PRIVATE, 'Chat with Ana', ana.id, [
    msg('2026-02-11T21:30:00', { body: HOSTILE, participantName: 'Bo' }),
    msg('2026-02-12T08:00:00', { body: 'nothing to see' }),
  ]);
  await load(lib, GROUP, 'Family group', bo.id, [msg('2026-03-14T18:00:00', { body: 'una altra cançó', participantName: 'Eve' })]);
  return { ana, bo };
}

let view: (Rendered & { lib: Lib }) | undefined;
async function open(query: string, prepare: (lib: Lib) => Promise<unknown> = seed, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  const data = await prepare(lib);
  search = query;
  view = await renderWithLibrary(<SearchScreen />, { lib, messages });
  await settle();
  return { lib, data: data as Awaited<ReturnType<typeof seed>> };
}

const text = () => view!.container.textContent ?? '';
const field = () => view!.container.querySelector<HTMLInputElement>('input[type="search"]')!;
const results = () => [...view!.container.querySelectorAll('ul[aria-label] > li')];
const calls = () => vi.mocked(searchMessages).mock.calls;

async function typeInto(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  counter = 0;
  vi.mocked(searchMessages).mockClear();
  vi.mocked(buildSearchIndex).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  view?.unmount();
  view = undefined;
});

describe('SearchScreen', () => {
  test('?q= searches on open: an accent-less query finds the accented word, marked, as text only', async () => {
    await open('q=canco');
    expect(field().value).toBe('canco');
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(results()).toHaveLength(2);
    // newest first, with when, who, which conversation
    expect(results()[0].textContent).toContain('Mar 14, 2026');
    expect(results()[0].textContent).toContain('Eve');
    expect(results()[0].textContent).toContain('Family group');
    expect(results()[1].textContent).toContain('Chat with Ana');
    expect(text()).toContain('2 results');
    expect([...view!.container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['cançó', 'cançó']);
    expect(results()[1].textContent).toContain('onerror="window.__pwned=1"> la <b>cançó</b>');
    expect(view!.container.querySelector('img, li b')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test('a result opens its conversation at that day; scoped to a person it keeps the way back', async () => {
    await open('q=canco');
    expect(results().map((li) => li.querySelector('a')!.getAttribute('href'))).toEqual([`/conversation?id=${GROUP}&date=2026-03-14`, `/conversation?id=${PRIVATE}&date=2026-02-11`]);
    expect(results()[0].querySelector('a')!.textContent).toBe(t.open);
    view!.unmount();
    const { data } = await open('q=canco');
    view!.unmount();
    search = `person=${data.ana.id}&q=canco`;
    view = await renderWithLibrary(<SearchScreen />, { lib: view!.lib });
    await settle();
    expect(results()).toHaveLength(1);
    expect(results()[0].querySelector('a')!.getAttribute('href')).toBe(`/conversation?id=${PRIVATE}&from=${data.ana.id}&date=2026-02-11`);
  });

  test('says where it searches and widens to everything with the typed query', async () => {
    const { data } = await open('');
    expect(text()).toContain(t.scopeAll);
    expect(view!.container.querySelector('a[href^="/search?q"]')).toBeNull();
    view!.unmount();
    search = `person=${data.ana.id}`;
    view = await renderWithLibrary(<SearchScreen />, { lib: view!.lib });
    await settle();
    expect(text()).toContain('Searching in Ana');
    await typeInto('can ço');
    expect(view!.container.querySelector('a[href="/search?q=can%20%C3%A7o"]')?.textContent).toBe(t.widen);
    expect(view!.container.querySelector(`a[href="/person?id=${data.ana.id}"]`)?.textContent).toBe('Back to Ana');
  });

  test('a conversation scope names the conversation (as text) and goes back to it', async () => {
    await open(`conversation=${GROUP}&q=canco`);
    expect(text()).toContain('Searching in “Family group”');
    expect(results()).toHaveLength(1);
    expect(view!.container.querySelector(`a[href="/conversation?id=${GROUP}"]`)?.textContent).toBe('Back to “Family group”');
  });

  test('a malformed or unknown id, or both scopes at once, is a calm not-found', async () => {
    for (const q of ['person=nope', `person=${uuid(999)}`, `conversation=${uuid(999)}`, `person=${uuid(1)}&conversation=${GROUP}`]) {
      await open(q);
      expect(view!.container.querySelector('h1')?.textContent, q).toBe(t.notFoundTitle);
      expect(field(), q).toBeNull();
      view!.unmount();
    }
  });

  test('typing waits for a pause: one search for what was typed, not one per keystroke', async () => {
    await open('');
    vi.useFakeTimers();
    for (const value of ['ca', 'can', 'canc', 'canco']) {
      await typeInto(value);
      await advance(100);
    }
    expect(calls()).toHaveLength(0);
    await advance(250);
    await advance(0);
    expect(calls().map((c) => c[2])).toEqual(['canco']);
    expect(results()).toHaveLength(2);
  });

  test('Enter searches at once', async () => {
    await open('');
    vi.useFakeTimers();
    await typeInto('canco');
    await act(async () => view!.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await advance(0);
    expect(calls().map((c) => c[2])).toEqual(['canco']);
  });

  test('under 2 letters it says so calmly and does not search; empty shows a hint', async () => {
    await open('');
    expect(text()).toContain(t.hint);
    vi.useFakeTimers();
    await typeInto('c');
    await advance(300);
    expect(text()).toContain(t.tooShort);
    expect(calls()).toHaveLength(0);
    expect(field().getAttribute('type')).toBe('search');
    expect(view!.container.querySelector('label[for="search-field"]')?.textContent).toBe(t.fieldLabel);
  });

  test('the clear button empties the field and keeps focus there', async () => {
    await open('q=canco');
    const clear = view!.container.querySelector<HTMLButtonElement>(`button[aria-label="${t.clear}"]`)!;
    expect(clear.className).toContain('size-11');
    await act(async () => clear.click());
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(view!.container.querySelector(`button[aria-label="${t.clear}"]`)).toBeNull();
  });

  test('only the latest answer counts: a slow earlier search cannot replace a newer one', async () => {
    const { lib } = await open('');
    const real = vi.mocked(searchMessages).getMockImplementation()!;
    let releaseFirst: (items: SearchResult[]) => void = () => {};
    vi.mocked(searchMessages).mockImplementationOnce(() => new Promise<SearchResult[]>((resolve) => (releaseFirst = resolve)));
    vi.useFakeTimers();
    await typeInto('canco');
    await advance(300);
    expect(calls()).toHaveLength(1);
    vi.mocked(searchMessages).mockImplementation(real);
    await typeInto('altra');
    await advance(300);
    await advance(0);
    expect(calls().map((c) => c[2])).toEqual(['canco', 'altra']);
    expect(results()).toHaveLength(1);
    const stale = await real(lib.deps, undefined, 'canco', 0, 50);
    await act(async () => releaseFirst(stale));
    expect(results()).toHaveLength(1);
    expect(results()[0].textContent).toContain('una altra');
  });

  test('results come 50 at a time with Show more, from the number already shown', async () => {
    await open('q=lluna', async (lib) => {
      const ana = await createProfile(lib.deps, { displayName: 'Ana' });
      const many = Array.from({ length: 120 }, (_, i) =>
        msg(`2026-03-01T${String(8 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`, { body: `lluna ${i}`, ordinal: i }),
      );
      await load(lib, PRIVATE, 'Chat with Ana', ana.id, many);
    });
    expect(results()).toHaveLength(50);
    expect(text()).toContain('50 results shown. There are more.');
    const more = () => [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.showMore)!;
    await act(async () => more().click());
    await settle();
    expect(results()).toHaveLength(100);
    expect(calls().map((c) => c[3])).toEqual([0, 50]);
    await act(async () => more().click());
    await settle();
    expect(results()).toHaveLength(120);
    expect([...view!.container.querySelectorAll('button')].some((b) => b.textContent === t.showMore)).toBe(false);
    expect(new Set(results().map((li) => li.textContent)).size).toBe(120);
  });

  test('a failed later page keeps what is shown and says so', async () => {
    await open('q=lluna', async (lib) => {
      const ana = await createProfile(lib.deps, { displayName: 'Ana' });
      await load(lib, PRIVATE, 'Chat with Ana', ana.id, Array.from({ length: 60 }, (_, i) => msg(`2026-03-01T08:${String(i).padStart(2, '0')}:00`, { body: `lluna ${i}` })));
    });
    vi.mocked(searchMessages).mockRejectedValueOnce(new Error('boom'));
    await act(async () => [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.showMore)!.click());
    await settle();
    expect(results()).toHaveLength(50);
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toBe(t.moreFailed);
  });

  test('no match: a calm empty state that repeats the query as text', async () => {
    await open('q=%3Cb%3Ezzz');
    expect(results()).toHaveLength(0);
    expect(text()).toContain('No messages match “<b>zzz”.');
    expect(text()).toContain(t.noResultsHint);
    expect(view!.container.querySelector('section b')).toBeNull();
  });

  test('an error offers Try again, which searches again', async () => {
    await open('q=canco');
    vi.mocked(searchMessages).mockRejectedValueOnce(new Error('boom'));
    await typeInto('altra');
    await act(async () => view!.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    const alert = view!.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(t.loadFailed);
    await act(async () => alert.querySelector('button')!.click());
    await settle();
    expect(view!.container.querySelector('[role="alert"]')).toBeNull();
    expect(results()).toHaveLength(1);
  });

  test('"unavailable" says search is down and the rest works; no results, no retry loop', async () => {
    await open('');
    vi.mocked(searchMessages).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'unavailable' }));
    await typeInto('canco');
    await act(async () => view!.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(text()).toContain(t.unavailableTitle);
    expect(text()).toContain(t.unavailableBody);
    expect(results()).toHaveLength(0);
  });

  test('an index that cannot be built is "unavailable" too', async () => {
    vi.mocked(buildSearchIndex).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'unavailable' }));
    await open('q=canco');
    expect(text()).toContain(t.unavailableTitle);
    expect(calls()).toHaveLength(0);
  });

  test('first use: Preparing search with progress, then the results; the bar is a progress element', async () => {
    let finish: () => void = () => {};
    vi.mocked(buildSearchIndex).mockImplementationOnce(async (deps, options) => {
      options?.onProgress?.({ done: 1, total: 3 });
      await new Promise<void>((resolve) => (finish = resolve));
      const { buildSearchIndex: real } = await vi.importActual<typeof import('@/lib/usecases/search')>('@/lib/usecases/search');
      return real(deps, options);
    });
    await open('q=canco');
    expect(text()).toContain(t.preparingTitle);
    expect(text()).toContain('1 of 3 messages');
    const bar = view!.container.querySelector('progress')!;
    expect(bar.value).toBe(1);
    expect(bar.max).toBe(3);
    expect(view!.container.querySelector('[role="status"].sr-only')?.textContent).toBe('Preparing search: 20%');
    expect(results()).toHaveLength(0);
    await act(async () => finish());
    await settle();
    expect(view!.container.querySelector('progress')).toBeNull();
    expect(results()).toHaveLength(2);
  });

  test('Cancel stops the work and keeps search usable: Prepare search resumes', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(buildSearchIndex).mockImplementationOnce((_deps, options) => {
      signal = options?.signal;
      options?.onProgress?.({ done: 1, total: 3 });
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)));
    });
    await open('q=canco');
    const cancel = [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.cancel)!;
    expect(cancel.className).toContain('min-h-11');
    await act(async () => cancel.click());
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(text()).toContain(t.cancelledTitle);
    expect(results()).toHaveLength(0);
    await act(async () => [...view!.container.querySelectorAll('button')].find((b) => b.textContent === t.resume)!.click());
    await settle();
    expect(results()).toHaveLength(2);
  });

  test('leaving the screen aborts the work', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(buildSearchIndex).mockImplementationOnce((_deps, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    await open('q=canco');
    expect(signal?.aborted).toBe(false);
    view!.unmount();
    expect(signal?.aborted).toBe(true);
  });

  test('a stale index (after a change) says the search is being refreshed, not that something is wrong', async () => {
    const { lib } = await open('', seed);
    await buildSearchIndex(lib.deps);
    view!.unmount();
    await lib.client.call('importMessages', {
      batchId: uuid(0x900),
      conversationId: PRIVATE,
      source: 'whatsapp',
      sourceLabel: 'y.zip',
      now: '2026-04-02T12:00:00Z',
      blobs: [],
      messages: [msg('2026-04-02T09:00:00', { body: 'nova cançó' })],
    });
    vi.mocked(buildSearchIndex).mockImplementationOnce(async (_deps, options) => {
      options?.onProgress?.({ done: 0, total: 4 });
      return new Promise(() => {});
    });
    search = 'q=canco';
    view = await renderWithLibrary(<SearchScreen />, { lib });
    await settle();
    expect(text()).toContain(en.search.refreshingTitle);
    expect(text()).not.toContain(t.preparingTitle);
  });

  test('the address follows the query (replace, not a history entry)', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    await open('');
    vi.useFakeTimers();
    await typeInto('canco');
    await advance(300);
    expect(replace).toHaveBeenCalled();
    expect(String(replace.mock.calls.at(-1)![2])).toContain('q=canco');
    replace.mockRestore();
  });

  test('speaks Catalan with the same screen', async () => {
    await open('q=canco', seed, ca);
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.search.title);
    expect(text()).toContain(ca.search.scopeAll);
  });
});
