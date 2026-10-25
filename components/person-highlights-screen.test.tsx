import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { PERSON_HIGHLIGHTS_PAGE } from '@/hooks/use-person-highlights';
import { countHighlights, importFindings } from '@/lib/usecases/highlights';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { CHAT, findingsOf, fp, HOSTILE_TITLE, seedHighlights } from './highlights-fixture';
import { load, msg, seedNotes, uuid, type Lib } from './notes-fixture';
import { PersonHighlightsScreen } from './person-highlights-screen';
import { PersonScreen } from './person-screen';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';

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

const t = en.personHighlights;
let view: (Rendered & { lib: Lib }) | undefined;
let ana = '';

// happy-dom has no modal <dialog>: a local stand-in that toggles `open`.
beforeEach(() => {
  search = '';
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function open(ui: React.ReactNode, options: { seed?: boolean; messages?: Record<string, unknown>; prepare?: (lib: Lib) => Promise<void> } = {}) {
  const lib = await createTestLibrary();
  const seeded = options.seed === false ? await seedNotes(lib) : await seedHighlights(lib);
  ana = seeded.ana.id;
  await options.prepare?.(lib);
  search = `id=${ana}`;
  view = await renderWithLibrary(ui, { lib, messages: options.messages });
  await settle();
  return lib;
}

const cards = () => [...view!.container.querySelectorAll('main li')].filter((li) => li.querySelector('h3'));
const card = (title: string) => cards().find((c) => c.querySelector('h3')?.textContent === title)!;
const text = () => view!.container.textContent ?? '';
const button = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
const headings = () => [...view!.container.querySelectorAll('main h2')].map((h) => h.textContent);

describe('PersonHighlightsScreen', () => {
  test('groups highlights by category with counts, as text, with where each goes', async () => {
    await open(<PersonHighlightsScreen />);
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(text()).toContain('4 highlights about Ana M.');
    expect(headings().slice(0, 3)).toEqual(['Moments (2)', 'Patterns (1)', 'Interests (1)']);
    expect(cards()).toHaveLength(4);
    const hostile = card(HOSTILE_TITLE);
    expect(hostile).toBeTruthy();
    expect(view!.container.querySelector('img')).toBeNull();
    expect(card('Title m1').textContent).toContain('Summary m1');
    expect(card('Title m1').textContent).toContain('Chat');
    expect(card('Title m1').textContent).toContain('2 messages');
    expect(card('Title m1').textContent).toContain('Mar 17, 2026');
    expect(card('Title m1').querySelector('a')!.getAttribute('href')).toBe(`/conversation?id=${CHAT}&from=${ana}&date=2026-03-17`);
  });

  test('filter chips narrow the list to one category and back', async () => {
    await open(<PersonHighlightsScreen />);
    const chips = () => [...view!.container.querySelectorAll('[role="group"] button')];
    expect(chips().map((c) => c.textContent)).toEqual(['All4', 'Moments2', 'Patterns1', 'Interests1']);
    expect(chips()[0].getAttribute('aria-pressed')).toBe('true');
    await click(chips()[2]);
    await settle();
    expect(cards()).toHaveLength(1);
    expect(card('Title p1')).toBeTruthy();
    expect(chips()[2].getAttribute('aria-pressed')).toBe('true');
    await click(chips()[2]);
    await settle();
    expect(cards()).toHaveLength(4);
  });

  test('deleting asks first, then removes the card, lowers the counts and says so; cancel changes nothing', async () => {
    const lib = await open(<PersonHighlightsScreen />);
    const c = card('Title p1');
    await click(button(c, t.deleteLabel.replace('{title}', 'Title p1')));
    const dialog = c.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(t.deleteBody);
    await click(button(dialog, t.cancel));
    expect(c.querySelector('dialog')).toBeNull();
    expect(await countHighlights(lib.deps)).toBe(4);

    await click(button(c, t.deleteLabel.replace('{title}', 'Title p1')));
    await click(button(c.querySelector('dialog')!, t.deleteConfirm));
    await settle();
    expect(cards()).toHaveLength(3);
    expect(text()).toContain('3 highlights about Ana M.');
    expect(headings()).not.toContain('Patterns (1)');
    expect([...view!.container.querySelectorAll('[role="status"]')].map((e) => e.textContent)).toContain(t.deleted);
    expect(await countHighlights(lib.deps)).toBe(3);
    expect(document.activeElement).toBe(view!.container.querySelector('h1'));
  });

  test('a deleted highlight comes back when its file is imported again', async () => {
    const lib = await open(<PersonHighlightsScreen />);
    await click(button(card('Title p1'), t.deleteLabel.replace('{title}', 'Title p1')));
    await click(button(card('Title p1').querySelector('dialog')!, t.deleteConfirm));
    await settle();
    const result = await importFindings(lib.deps, CHAT, findingsOf([{ id: 'p1', category: 'pattern', title: 'Title p1', summary: 'Summary p1', messages: [fp(3)], createdBy: 'test', createdAt: '2026-02-01T10:00:00Z' }]));
    expect(result.imported).toBe(1);
  });

  test('pages 50 at a time per group with Show more', async () => {
    const total = PERSON_HIGHLIGHTS_PAGE + 3;
    await open(<PersonHighlightsScreen />, {
      seed: false,
      prepare: async (lib) => {
        const rows = Array.from({ length: total }, (_, i) => msg({ sentAt: `2026-04-01T10:${String(i % 60).padStart(2, '0')}:00`, body: `bulk ${i}`, participantName: 'Bo' }));
        await load(lib, uuid(0x30), 'Bulk', ana, rows);
        const highlights = rows.map((r, i) => ({ id: `h${i}`, category: 'moment' as const, title: `Bulk ${i}`, summary: '', messages: [r.fingerprint], createdBy: 'test', createdAt: '2026-02-01T10:00:00Z' }));
        await importFindings(lib.deps, uuid(0x30), { version: 1, conversation: { name: 'Bulk', messageCount: total }, highlights });
      },
    });
    expect(cards()).toHaveLength(PERSON_HIGHLIGHTS_PAGE);
    expect(text()).toContain(`Showing ${PERSON_HIGHLIGHTS_PAGE} of ${total}`);
    await click(button(view!.container, t.showMore));
    await settle();
    expect(cards()).toHaveLength(total);
    expect(text()).not.toContain(t.showMore);
  });

  test('says there are no highlights yet, and still offers the import', async () => {
    await open(<PersonHighlightsScreen />, { seed: false });
    expect(text()).toContain('There are no highlights for Ana M. yet.');
    expect(text()).toContain(t.emptyHint);
    expect(text()).toContain(en.highlightsImport.title);
    expect(view!.container.querySelector('[role="group"]')).toBeNull();
  });

  test('an unknown person is not-found, a failing read an error with Retry', async () => {
    await open(<PersonHighlightsScreen />);
    view!.unmount();
    search = 'id=00000000-0000-4000-8000-0000000000ff';
    view = await renderWithLibrary(<PersonHighlightsScreen />);
    await settle();
    expect(text()).toContain(en.person.notFoundTitle);
    view.unmount();

    const lib = await createTestLibrary();
    ana = (await seedHighlights(lib)).ana.id;
    search = `id=${ana}`;
    let fail = true;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) =>
      method === 'countHighlightsByCategory' && fail ? Promise.reject(new Error('disk')) : call(method, params);
    view = await renderWithLibrary(<PersonHighlightsScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain(t.loadFailed);
    fail = false;
    await click(button(view.container, en.library.retry));
    await settle();
    expect(cards()).toHaveLength(4);
  });

  test('is translated', async () => {
    await open(<PersonHighlightsScreen />, { messages: ca });
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.personHighlights.title);
    expect(headings()[0]).toBe('Moments (2)');
    expect(text()).toContain(ca.personHighlights.open);
  });
});

describe('the person page', () => {
  test('leads to Highlights with their count', async () => {
    await open(<PersonScreen />);
    const link = [...view!.container.querySelectorAll('nav a')].find((a) => a.textContent?.includes(en.person.sectionHighlights))!;
    expect(link.getAttribute('href')).toBe(`/person/highlights?id=${ana}`);
    expect(link.textContent).toContain('4');
  });
});
