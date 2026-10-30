import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { createSyntheticConversation } from '@/lib/db/synthetic-archive';
import type { NewMessage } from '@/lib/domain/library';
import { getMessageWindow } from '@/lib/usecases/conversation-view';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { MAX_PAGES, PAGE_SIZE } from '@/hooks/message-pages';
import { renderWithLibrary, settle, type, type Rendered } from './test-utils';
import { ConversationScreen } from './conversation-screen';

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

const c = en.conversation;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CONV = uuid(0x20);
const NOW = '2026-02-01T12:00:00Z';
const VIEWPORT = 600;
const ROW = 64; // the estimate; happy-dom has no layout, so rows keep it

const text = (n: number, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-03-17T10:${String(n).padStart(2, '0')}:00`,
  ordinal: 0,
  type: 'text',
  participantName: n % 2 ? 'Bo' : 'Ana',
  body: `hello ${n}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

async function seed(lib: Lib, messages: NewMessage[], blobs: Array<{ sha256: string; size: number; mime: string | null }> = []) {
  const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
  await lib.client.call('importMessages', {
    batchId: uuid(0x100),
    conversationId: CONV,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs,
    messages,
    newConversation: { title: 'Chat with Ana', sourceKey: 'ana', isGroup: false, profileIds: [ana.id] },
    meAuthor: 'Ana',
  });
  return { ana };
}

let view: View | undefined;
async function open(prepare: (lib: Lib) => Promise<void>, query = `id=${CONV}`, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  await prepare(lib);
  search = query;
  view = await renderWithLibrary(<ConversationScreen />, { lib, messages });
  await settle();
  return view;
}

const feed = () => view!.container.querySelector<HTMLElement>('[role="feed"]')!;
const articles = () => [...feed().querySelectorAll<HTMLElement>('article')];
const rows = () => feed().querySelectorAll('[data-index]');
const positions = () => articles().map((a) => Number(a.getAttribute('aria-posinset')));
const button = (label: string) => [...view!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
async function scrollTo(top: number) {
  await act(async () => {
    feed().scrollTop = top;
    feed().dispatchEvent(new Event('scroll'));
  });
  await settle();
}

beforeEach(() => {
  // No layout in happy-dom: the feed is 600 px tall, nothing else has a height.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.getAttribute('role') === 'feed' ? VIEWPORT : 0; } });
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  sessionStorage.clear();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('ConversationScreen', () => {
  test('header: title, who it is kept under, count and dates, back to the person', async () => {
    const { ana } = { ana: { id: '' } };
    await open(async (lib) => void Object.assign(ana, (await seed(lib, [text(1), text(2), text(3)])).ana));
    expect(view!.container.querySelector('h1')?.textContent).toBe('Chat with Ana');
    const header = view!.container.querySelector('header')!;
    expect(header.textContent).toContain('3 messages');
    expect(header.textContent).toContain('2026');
    expect(header.textContent).toContain('Kept under Ana M.');
    const back = header.querySelector('a')!;
    expect(back.textContent).toContain('Back to Ana M.'); // the pill is an icon; the name is for screen readers
    expect(back.getAttribute('href')).toBe(`/person?id=${ana.id}`);
    const searchLink = header.querySelector<HTMLAnchorElement>('a[href^="/search?conversation="]')!;
    expect(searchLink.getAttribute('aria-label')).toBe('Search in this conversation');
    expect(searchLink.getAttribute('href')).toMatch(/^\/search\?conversation=[0-9a-f-]{36}$/);
  });

  test('?back= returns to the Highlights or Favorites of the person; any other value is ignored (never a path)', async () => {
    const ana = { id: '' };
    await open(async (lib) => void Object.assign(ana, (await seed(lib, [text(1)])).ana));
    const backLink = () => view!.container.querySelector('header a')!;
    const reopen = async (extra: string) => {
      const lib = view!.lib;
      view!.unmount();
      search = `id=${CONV}&from=${ana.id}${extra}`;
      view = await renderWithLibrary(<ConversationScreen />, { lib });
      await settle();
    };
    await reopen('&back=highlights');
    expect(backLink().getAttribute('href')).toBe(`/person/highlights?id=${ana.id}`);
    expect(backLink().textContent).toBe("Back to Ana M.'s highlights");
    await reopen('&back=favorites');
    expect(backLink().getAttribute('href')).toBe(`/person/favorites?id=${ana.id}`);
    for (const bad of ['https://evil.example', '//evil.example', '/people', 'timeline', '']) {
      await reopen(`&back=${encodeURIComponent(bad)}`);
      expect(backLink().getAttribute('href')).toBe(`/person?id=${ana.id}`);
    }
  });

  test('a conversation that is not assigned says so and goes back to People', async () => {
    await open(async (lib) => {
      await seed(lib, [text(1)]);
      const [row] = await lib.client.call('listConversations');
      await lib.client.call('unlinkConversationProfile', { conversationId: row.id, profileId: row.profileIds[0] });
    });
    expect(view!.container.querySelector('header')!.textContent).toContain(c.unassigned);
    expect(view!.container.querySelector('header a')!.getAttribute('href')).toBe('/people');
  });

  test('opens at the last message, like a chat, and shows date separator, author, time and alignment', async () => {
    await open((lib) => seed(lib, [text(1), text(2), text(3, { participantName: null, type: 'system', body: 'Ana changed the subject' }), text(4)]).then(() => {}));
    expect(positions()).toEqual([1, 2, 3, 4]);
    expect(feed().getAttribute('aria-label')).toBe('Messages in “Chat with Ana”');
    expect(feed().scrollTop).toBe(Math.max(0, 4 * ROW - VIEWPORT));
    const [first, second, system, last] = articles();
    // one date separator, for the first message of the day, spelled out
    expect(first.textContent).toContain('Tuesday, March 17, 2026');
    expect(second.textContent).not.toContain('Tuesday');
    expect(first.getAttribute('aria-label')).toBe('Bo, Tuesday, March 17, 2026, 10:01');
    expect(first.textContent).toContain('10:01');
    expect(first.querySelector('time')!.getAttribute('datetime')).toBe('2026-03-17T10:01:00');
    // Ana is the user: right; Bo: left
    expect(second.querySelector('.justify-end')).not.toBeNull();
    expect(first.querySelector('.justify-start')).not.toBeNull();
    // a system message is a quiet centered notice, not a bubble
    expect(system.getAttribute('aria-label')).toMatch(/^Notice, /);
    expect(system.querySelector('p')!.className).toContain('italic');
    expect(system.querySelector('time')).toBeNull();
    // the author's name appears when the author changes, not on every message; your own bubbles carry none
    expect(first.textContent).toContain('Bo');
    expect(last.textContent).not.toContain('Ana');
    expect(feed().getAttribute('aria-busy')).toBe('false');
  });

  test('a notice from the source falls back to calm copy when it has no text', async () => {
    await open((lib) => seed(lib, [text(1, { type: 'deleted', body: '' }), text(2, { type: 'omitted', body: '' })]).then(() => {}));
    expect(articles().map((a) => a.querySelector('p')!.textContent)).toEqual([c.deleted, c.omitted]);
  });

  test('empty conversation: a calm note, no feed', async () => {
    await open(async (lib) => {
      const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
      await lib.client.call('createConversation', { id: CONV, title: 'Empty', source: 'whatsapp', isGroup: false, profileIds: [ana.id], participants: [], now: NOW });
    });
    expect(view!.container.textContent).toContain(c.empty);
    expect(view!.container.querySelector('[role="feed"]')).toBeNull();
  });

  test.each([
    ['no id', ''],
    ['an id that is not a UUID', 'id=../../etc'],
    ['an unknown id', `id=${uuid(0x99)}`],
  ])('%s: a calm not-found with the way back, nothing else', async (_name, query) => {
    await open((lib) => seed(lib, [text(1)]).then(() => {}), query);
    expect(view!.container.querySelector('h1')!.textContent).toBe(c.notFoundTitle);
    expect(view!.container.textContent).toContain(c.notFoundBody);
    expect(view!.container.querySelector('[role="feed"]')).toBeNull();
    expect(view!.container.querySelector('a[href="/people"]')).not.toBeNull();
  });

  test('Catalan copy', async () => {
    await open((lib) => seed(lib, [text(1)]).then(() => {}), `id=${CONV}`, ca);
    expect(view!.container.querySelector('header')!.textContent).toContain('1 missatge');
    expect(button(ca.conversation.toStart)).toBeDefined();
    expect(feed().getAttribute('aria-label')).toBe('Missatges de «Chat with Ana»');
  });
});

describe('virtualization', () => {
  const synthetic = (count: number) => async (lib: Lib) => {
    const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
    createSyntheticConversation(lib.opened.db, { count, conversationId: CONV });
    await lib.client.call('linkConversationProfile', { conversationId: CONV, profileId: ana.id });
  };

  test('20,000 messages: opens at the end with only the rows near the view in the DOM', async () => {
    await open(synthetic(20_000));
    expect(view!.container.querySelector('header')!.textContent).toContain('20,000 messages');
    expect(feed().getAttribute('aria-label')).toBe('Messages in “Synthetic”');
    expect(positions().at(-1)).toBe(20_000);
    expect(articles().every((a) => a.getAttribute('aria-setsize') === '20000')).toBe(true);
    // the view is 600 px plus 640 px of margin on each side: a few dozen rows, never thousands
    expect(rows().length).toBeLessThan(60);
    expect(view!.container.querySelectorAll('*').length).toBeLessThan(1200);
    expect(feed().scrollTop).toBe(20_000 * ROW - VIEWPORT);
    expect(feed().firstElementChild!.getAttribute('style')).toContain(`height: ${20_000 * ROW}px`);
    expect(feed().textContent).toContain('synthetic message 19999');
  });

  test('Go to start shows the first message; Go to latest comes back', async () => {
    await open(synthetic(20_000));
    await click(button(c.toStart));
    await settle();
    expect(feed().scrollTop).toBe(0);
    expect(positions()[0]).toBe(1);
    expect(feed().textContent).toContain('synthetic message 0');
    expect(rows().length).toBeLessThan(60);
    await click(button(c.toEnd));
    await settle();
    expect(positions().at(-1)).toBe(20_000);
  });

  test('scrolling far away loads only the pages there; far pages are dropped and read again when needed', async () => {
    const lib = await createTestLibrary();
    await synthetic(20_000)(lib);
    const windows: number[] = [];
    const call = lib.client.call.bind(lib.client);
    (lib.client as { call: unknown }).call = ((op: string, params: { offset?: number }) => {
      if (op === 'getMessageWindow') windows.push(params.offset!);
      return (call as (op: string, params: unknown) => unknown)(op, params);
    }) as typeof lib.client.call;
    search = `id=${CONV}`;
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    const atOpen = windows.length;
    expect(atOpen).toBeGreaterThan(0);
    expect(atOpen).toBeLessThanOrEqual(8); // the last pages and a neighbour, not the archive
    // walk through more pages than the cache keeps
    for (let page = 0; page <= MAX_PAGES + 4; page++) await scrollTo(page * PAGE_SIZE * ROW);
    expect(windows.every((offset) => offset < 20_000)).toBe(true);
    const before = windows.length;
    expect(before).toBeLessThan(atOpen + (MAX_PAGES + 5) * 3);
    // page 0 was dropped long ago: going back reads it again
    const readsOfStart = () => windows.filter((o) => o <= 1).length;
    const first = readsOfStart();
    await scrollTo(0);
    expect(readsOfStart()).toBe(first + 1);
    expect(feed().textContent).toContain('synthetic message 0');
    // ... but a page still cached is not read twice
    const again = windows.length;
    await scrollTo(10 * ROW);
    expect(windows.length).toBe(again);
  });

  test('jump to a date: the first message of that day is at the top; a day past the end says so', async () => {
    await open(synthetic(20_000));
    await click(button(c.goToDate)); // the plain date field lives in the calendar sheet
    await settle();
    const input = view!.container.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(input.min).toBe('2020-01-01');
    expect(input.max).toBe('2020-04-09');
    await type(input, '2020-03-01'); // day 60 of 200 messages a day: offset 12,000
    await settle();
    expect(feed().scrollTop).toBe(12_000 * ROW);
    expect(positions()).toContain(12_001);
    expect(feed().textContent).toContain('synthetic message 12000');
    expect(view!.container.querySelector('[role="status"]')!.textContent).toBe('Showing the first message on or after Mar 1, 2020.');
    await type(input, '2021-01-01');
    await settle();
    expect(view!.container.querySelector('[role="status"]')!.textContent).toBe('There are no messages on or after Jan 1, 2021.');
    expect(feed().scrollTop).toBe(12_000 * ROW);
  });

  test('?date= opens at that day', async () => {
    await open(synthetic(20_000), `id=${CONV}&date=2020-02-01`);
    expect(feed().scrollTop).toBe(6_200 * ROW);
    expect(positions()).toContain(6_201);
  });

  test('?message= scrolls to that message, marks and focuses it and says so; an invalid id is ignored', async () => {
    await open(synthetic(20_000), `id=${CONV}&date=2020-02-01`);
    const [target] = await getMessageWindow(view!.lib.deps, CONV, 12_000, 1);
    view!.unmount();
    search = `id=${CONV}&date=2020-02-01&message=${target.id}`;
    view = await renderWithLibrary(<ConversationScreen />, { lib: view!.lib });
    await settle();
    expect(feed().scrollTop).toBe(12_000 * ROW);
    const row = feed().querySelector<HTMLElement>('[data-index="12000"]')!;
    expect(row.className).toContain('jump-flash');
    expect(document.activeElement).toBe(row);
    expect(view!.container.querySelector('[role="status"]')!.textContent).toMatch(/^Message from /);

    for (const bad of ['abc', '0', '-1', `${target.id}x`, '99999999']) {
      view!.unmount();
      search = `id=${CONV}&date=2020-02-01&message=${bad}`;
      view = await renderWithLibrary(<ConversationScreen />, { lib: view!.lib });
      await settle();
      expect(feed().scrollTop).toBe(6_200 * ROW);
      expect(feed().querySelector('.jump-flash')).toBeNull();
    }
  });

  test('where the person left off is restored when they come back', async () => {
    await open(synthetic(20_000));
    await scrollTo(5_000 * ROW + 10);
    view!.unmount();
    view = await renderWithLibrary(<ConversationScreen />, { lib: view!.lib });
    await settle();
    expect(feed().scrollTop).toBe(5_000 * ROW + 10);
  });
});

describe('calendar', () => {
  const synthetic = async (lib: Lib) => {
    const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
    createSyntheticConversation(lib.opened.db, { count: 20_000, conversationId: CONV });
    await lib.client.call('linkConversationProfile', { conversationId: CONV, profileId: ana.id });
  };
  const calls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([name]) => name === 'listConversationDays').length;
  const trigger = () => button(c.goToDate);
  const label = (text: string) => [...view!.container.querySelectorAll<HTMLElement>('#conversation-calendar button')].find((b) => b.getAttribute('aria-label')?.startsWith(text))!;

  test('days are read only when the calendar is first opened, once', async () => {
    const lib = await createTestLibrary();
    await synthetic(lib);
    const spy = vi.spyOn(lib.client, 'call');
    search = `id=${CONV}`;
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    expect(calls(spy)).toBe(0);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await click(trigger());
    await settle();
    expect(calls(spy)).toBe(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    await click(trigger());
    await click(trigger());
    await settle();
    expect(calls(spy)).toBe(1);
  });

  test('choosing a day jumps the feed there, announces it, closes the calendar and returns focus to the button', async () => {
    await open(synthetic);
    await click(trigger());
    await settle();
    expect(view!.container.querySelector('#conversation-calendar h2')!.textContent).toBe('Choose a month in 2020'); // one year: no years step
    await click(label('March'));
    await click(label('Sunday, March 1, 2020'));
    await settle();
    expect(feed().scrollTop).toBe(12_000 * ROW);
    expect(view!.container.querySelector('#conversation-calendar')).toBeNull();
    expect(view!.container.querySelector('[role="status"]')!.textContent).toBe('Showing the first message on or after Mar 1, 2020.');
    expect(document.activeElement).toBe(trigger());
  });

  test('Escape closes it and returns focus to the button', async () => {
    await open(synthetic);
    await click(trigger());
    await settle();
    await act(async () => void view!.container.querySelector('#conversation-calendar h2')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view!.container.querySelector('#conversation-calendar')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('a failed read says so, keeps the conversation, and Try again reads it', async () => {
    const lib = await createTestLibrary();
    await synthetic(lib);
    const real = lib.client.call.bind(lib.client) as (name: string, args?: unknown) => Promise<unknown>;
    let failing = true;
    vi.spyOn(lib.client, 'call').mockImplementation(((name: string, args?: unknown) =>
      name === 'listConversationDays' && failing ? Promise.reject(new Error('boom')) : real(name, args)) as never);
    search = `id=${CONV}`;
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    await click(trigger());
    await settle();
    const alert = view!.container.querySelector('#conversation-calendar [role="alert"]')!;
    expect(alert.textContent).toContain('The calendar could not be read. Nothing was deleted.');
    failing = false;
    await click([...alert.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!);
    await settle();
    expect(view!.container.querySelector('#conversation-calendar h2')!.textContent).toBe('Choose a month in 2020');
    expect(feed()).toBeTruthy();
  });
});

describe('untrusted text', () => {
  const hostile = [
    '<img src=x onerror="window.pwned=1"> <b>bold</b> <script>window.pwned=2</script>',
    'javascript:window.pwned=3 and [x](javascript:alert(1))',
    'read https://example.com/a?b=1&c=<2>. then done',
  ];

  test('markup in a message stays text; only http(s) addresses become links, opened safely', async () => {
    await open((lib) => seed(lib, hostile.map((body, i) => text(i + 1, { body, participantName: '<i>Mallory</i>' }))).then(() => {}));
    const list = feed();
    expect(list.querySelector('img, script, b, i')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror="window.pwned=1"> <b>bold</b> <script>window.pwned=2</script>');
    expect(list.textContent).toContain('<i>Mallory</i>');
    const links = [...list.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1&c=']);
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].textContent).toBe('example.com/a');
    expect(list.textContent).toContain('javascript:window.pwned=3');
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  test('text sets its own direction, so right-to-left messages read right; long words wrap', async () => {
    await open((lib) => seed(lib, [text(1, { body: 'مرحبا بك في الأرشيف' }), text(2, { body: 'x'.repeat(500) })]).then(() => {}));
    const paragraphs = [...feed().querySelectorAll('article p')];
    expect(paragraphs.map((p) => p.getAttribute('dir'))).toEqual(['auto', 'auto']);
    expect(paragraphs[1].className).toContain('[overflow-wrap:anywhere]');
    expect(feed().querySelector('.sender-name')!.getAttribute('dir')).toBe('auto');
  });
});

describe('media', () => {
  const PHOTO = 'ab'.repeat(32);
  const GONE = 'cd'.repeat(32);
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => text(from + i, { sentAt: `2026-03-17T${String(10 + Math.floor((from + i) / 60)).padStart(2, '0')}:${String((from + i) % 60).padStart(2, '0')}:00` }));

  async function withPhoto(lib: Lib) {
    const { sha256 } = await lib.deps.blobStore.put(new Uint8Array([1, 2, 3, 4]));
    expect(sha256).not.toBe(PHOTO);
    return sha256;
  }

  test('a photo is read only when its row is near the view, shown as an image, and released when it leaves', async () => {
    let hash = '';
    await open(async (lib) => {
      hash = await withPhoto(lib);
      const photo = text(1, { type: 'photo', body: 'a caption', mediaSha256: hash, mediaName: 'IMG-0001.jpg' });
      await seed(lib, [photo, ...filler(2, 300)], [{ sha256: hash, size: 4, mime: 'image/jpeg' }]);
    });
    // opened at the end: the photo, 300 rows up, has not been read
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(feed().querySelector('img')).toBeNull();
    await click(button(c.toStart));
    await settle();
    const img = feed().querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:mock-1');
    expect(img.getAttribute('alt')).toBe('IMG-0001.jpg');
    expect(feed().textContent).toContain('a caption');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(4);
    // scrolled away: the row unmounts and its URL is revoked
    await scrollTo(200 * ROW);
    expect(feed().querySelector('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  test('unmounting the screen revokes what is still shown', async () => {
    await open(async (lib) => {
      const hash = await withPhoto(lib);
      await seed(lib, [text(1, { type: 'photo', body: '', mediaSha256: hash, mediaName: 'a.jpg' })], [{ sha256: hash, size: 4, mime: null }]);
    });
    expect(feed().querySelector('img')!.getAttribute('src')).toBe('blob:mock-1');
    view!.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    view = undefined;
  });

  test('a file that is not in the archive is a calm note with its name, never a broken image', async () => {
    await open((lib) =>
      seed(
        lib,
        [
          text(1, { type: 'photo', body: '', mediaSha256: GONE, mediaName: 'LOST.jpg' }), // the database knows it, the store does not
          text(2, { type: 'photo', body: '', mediaSha256: null, mediaName: 'NEVER.jpg' }), // never stored
        ],
        [{ sha256: GONE, size: 10, mime: 'image/jpeg' }],
      ).then(() => {}),
    );
    const notes = [...feed().querySelectorAll('[role="note"]')];
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.textContent)).toEqual([`${en.conversation.media.missing}LOST.jpg`, `${en.conversation.media.missing}NEVER.jpg`]);
    expect(feed().querySelector('img')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('a video waits for Play; a voice message has its own play button and a document shows a chip', async () => {
    await open(async (lib) => {
      const hash = await withPhoto(lib);
      const blobs = [{ sha256: hash, size: 4, mime: null }];
      await seed(
        lib,
        [
          text(1, { type: 'video', body: '', mediaSha256: hash, mediaName: 'clip.mp4' }),
          text(2, { type: 'audio', body: '', mediaSha256: hash, mediaName: 'PTT-1.opus' }),
          text(3, { type: 'document', body: '', mediaSha256: hash, mediaName: 'report <final>.pdf' }),
        ],
        blobs,
      );
    });
    const audio = feed().querySelector('audio')!;
    // only the length is read up front; the round button is the control, not the browser's bar
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(feed().querySelector(`button[aria-label="${en.conversation.media.playLabel.replace('{name}', 'PTT-1.opus')}"]`)).not.toBeNull();
    expect(feed().querySelector('video')).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1); // only the voice message was read
    const chip = [...feed().querySelectorAll('article')][2];
    expect(chip.textContent).toContain('report <final>.pdf');
    expect(chip.textContent).toContain('4 byte');
    expect(chip.querySelector('a')).toBeNull(); // no auto-open, no download until asked
    await click(feed().querySelector(`button[aria-label="${en.conversation.media.playLabel.replace('{name}', 'clip.mp4')}"]`)!);
    await settle();
    const video = feed().querySelector('video')!;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  test('a voice message shows its length only once the file says it, and the button follows the audio', async () => {
    await open(async (lib) => {
      const hash = await withPhoto(lib);
      await seed(lib, [text(1, { type: 'audio', body: '', mediaSha256: hash, mediaName: 'PTT-1.opus' })], [{ sha256: hash, size: 4, mime: null }]);
    });
    const audio = feed().querySelector('audio')!;
    const play = en.conversation.media.playLabel.replace('{name}', 'PTT-1.opus');
    const pause = en.conversation.media.pauseLabel.replace('{name}', 'PTT-1.opus');
    expect(feed().querySelector('article')!.textContent).not.toMatch(/(?<!\d)\d:\d\d/);
    Object.defineProperty(audio, 'duration', { configurable: true, value: 83 });
    await act(async () => void audio.dispatchEvent(new Event('loadedmetadata')));
    expect(feed().querySelector('article')!.textContent).toContain('1:23');
    expect(feed().querySelector(`button[aria-label="${play}"]`)).not.toBeNull();
    await act(async () => void audio.dispatchEvent(new Event('play')));
    expect(feed().querySelector(`button[aria-label="${pause}"]`)).not.toBeNull();
    await act(async () => void audio.dispatchEvent(new Event('ended')));
    expect(feed().querySelector(`button[aria-label="${play}"]`)).not.toBeNull();
    // the waveform is decoration
    expect(feed().querySelector('article span[aria-hidden]')).not.toBeNull();
  });

  test('at most three files are read at a time', async () => {
    let active = 0;
    let peak = 0;
    await open(async (lib) => {
      const hashes: string[] = [];
      for (let i = 0; i < 8; i++) hashes.push((await lib.deps.blobStore.put(new Uint8Array([i, 9]))).sha256);
      const original = lib.deps.blobStore.file!.bind(lib.deps.blobStore);
      lib.deps.blobStore.file = async (sha: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return original(sha);
      };
      await seed(
        lib,
        hashes.map((h, i) => text(i + 1, { type: 'photo', body: '', mediaSha256: h, mediaName: `${i}.jpg` })),
        hashes.map((sha256) => ({ sha256, size: 2, mime: null })),
      );
    });
    await settle();
    await settle();
    expect(feed().querySelectorAll('img')).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('message details', () => {
  const d = en.conversation.details;
  const toggle = (article: HTMLElement) => article.querySelector<HTMLButtonElement>(`button[aria-label="${d.toggle}"]`)!;
  const panel = (article: HTMLElement) => article.querySelector<HTMLElement>('[id]:not(article)');
  /** Make `getMessageSource` fail with `code`, and count how often it is asked. */
  function failSource(lib: Lib, code: string | null, calls: { n: number }) {
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = async (method: string, params?: unknown) => {
      if (method === 'getMessageSource') {
        calls.n++;
        if (code !== null && (code !== 'retry' || calls.n === 1)) throw Object.assign(new Error('x'), { code: code === 'retry' ? 'internal' : code });
      }
      return call(method, params);
    };
  }

  test('a button toggles the details: aria-expanded, aria-controls, source and import date; nothing is read before', async () => {
    const calls = { n: 0 };
    await open(async (lib) => {
      await seed(lib, [text(1), text(2)]);
      failSource(lib, null, calls);
    });
    const [first] = articles();
    const button = toggle(first);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(panel(first)).toBeNull();
    expect(calls.n).toBe(0);

    await click(button);
    await settle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const details = panel(first)!;
    expect(button.getAttribute('aria-controls')).toBe(details.id);
    expect(details.textContent).toContain('Source: WhatsApp (x.zip)');
    expect(details.textContent).toMatch(/Imported .*Feb [12], 2026/);
    expect(calls.n).toBe(1);

    // closing and reopening does not read again
    await click(button);
    expect(panel(first)).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(panel(first)!.textContent).toContain('Source: WhatsApp (x.zip)');
    expect(calls.n).toBe(1);
  });

  test('the button is a real 44 px button with a name; notices have none', async () => {
    await open((lib) => seed(lib, [text(1), text(2, { type: 'system', participantName: null, body: 'changed' })]).then(() => {}));
    const [first, notice] = articles();
    expect(toggle(first).tagName).toBe('BUTTON');
    expect(toggle(first).className).toContain('size-11');
    expect(notice.querySelector('button')).toBeNull();
  });

  test('an empty label shows just WhatsApp; an unknown source and a hostile label are plain text', async () => {
    await open(async (lib) => {
      await seed(lib, [text(1), text(2)]);
      const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
      let n = 0;
      (lib.client as { call: unknown }).call = async (method: string, params?: unknown) => {
        if (method !== 'getMessageSource') return call(method, params);
        const real = (await call(method, params)) as object;
        return ++n === 1 ? { ...real, sourceLabel: '' } : { ...real, source: 'telegram', sourceLabel: '<img src=x onerror=alert(1)>' };
      };
    });
    const [first, second] = articles();
    await click(toggle(first));
    await settle();
    expect(panel(first)!.textContent).toContain('Source: WhatsApp');
    expect(panel(first)!.textContent).not.toContain('(');
    await click(toggle(second));
    await settle();
    expect(panel(second)!.textContent).toContain('Source: telegram (<img src=x onerror=alert(1)>)');
    expect(panel(second)!.querySelector('img')).toBeNull();
  });

  test('a message that is gone says so calmly; a failure offers Try again', async () => {
    const gone = { n: 0 };
    await open(async (lib) => {
      await seed(lib, [text(1)]);
      failSource(lib, 'not-found', gone);
    });
    await click(toggle(articles()[0]));
    await settle();
    expect(panel(articles()[0])!.textContent).toBe(d.notFound);
    view!.unmount();

    const flaky = { n: 0 };
    await open(async (lib) => {
      await seed(lib, [text(1)]);
      failSource(lib, 'retry', flaky);
    });
    await click(toggle(articles()[0]));
    await settle();
    const alert = view!.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(d.failed);
    await click([...alert.querySelectorAll('button')].find((b) => b.textContent === c.retry)!);
    await settle();
    expect(view!.container.querySelector('[role="alert"]')).toBeNull();
    expect(panel(articles()[0])!.textContent).toContain('Source: WhatsApp (x.zip)');
  });

  test('Catalan copy', async () => {
    await open((lib) => seed(lib, [text(1)]).then(() => {}), `id=${CONV}`, ca);
    await click(articles()[0].querySelector(`button[aria-label="${ca.conversation.details.toggle}"]`)!);
    await settle();
    expect(articles()[0].textContent).toContain('Origen: WhatsApp (x.zip)');
    expect(articles()[0].textContent).toContain('Importat el');
  });
});

