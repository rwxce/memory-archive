import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { PERSON_NOTES_PAGE } from '@/hooks/use-person-notes';
import { countNotes, getNote, setNote } from '@/lib/usecases/notes';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { CHAT, GROUP, HOSTILE, load, msg, seedNotes, uuid, type Lib } from './notes-fixture';
import { PersonNotesScreen } from './person-notes-screen';
import { PersonScreen } from './person-screen';
import { renderWithLibrary, settle, type, type Rendered } from './test-utils';

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

const t = en.personNotes;
const n = en.notes;
let view: (Rendered & { lib: Lib }) | undefined;
let seeded: Awaited<ReturnType<typeof seedNotes>>;

async function open(ui: React.ReactNode, prepare?: (lib: Lib) => Promise<void>, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  seeded = await seedNotes(lib);
  await prepare?.(lib);
  search = `id=${seeded.ana.id}`;
  view = await renderWithLibrary(ui, { lib, messages });
  await settle();
  return lib;
}

const writeAll = async (lib: Lib) => {
  await setNote(lib.deps, { kind: 'profile', profileId: seeded.ana.id }, 'About Ana');
  await setNote(lib.deps, { kind: 'conversation', conversationId: CHAT }, 'About the chat');
  await setNote(lib.deps, { kind: 'message', conversationId: CHAT, messageId: seeded.chatIds[3] }, HOSTILE);
  await setNote(lib.deps, { kind: 'message', conversationId: GROUP, messageId: seeded.groupIds[0] }, 'group note');
};
const cards = () => [...view!.container.querySelectorAll('li.rounded-xl')];
const card = (text: string) => cards().find((c) => c.textContent?.includes(text))!;
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const button = (root: Element, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;
const text = () => view!.container.textContent ?? '';

beforeEach(() => {
  search = '';
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('PersonNotesScreen', () => {
  test('lists notes on the person, a conversation and messages, as text, with where each belongs', async () => {
    await open(<PersonNotesScreen />, writeAll);
    expect(view!.container.querySelector('h1')?.textContent).toBe(t.title);
    expect(text()).toContain('4 notes about Ana M.');
    expect(cards()).toHaveLength(4);
    expect(card('About Ana').textContent).toContain(t.kind.profile);
    expect(card('About the chat').textContent).toContain(t.kind.conversation);
    const hostile = card(HOSTILE);
    expect(hostile.textContent).toContain(t.kind.message);
    expect(hostile.textContent).toContain('Mar 17, 2026');
    expect(hostile.textContent).toContain('Bo');
    expect(hostile.textContent).toContain('Chat');
    expect(view!.container.querySelector('img')).toBeNull();
    expect(hostile.querySelector('a')!.getAttribute('href')).toBe(`/conversation?id=${CHAT}&from=${seeded.ana.id}&date=2026-03-17`);
    expect(card('About the chat').querySelector('a')!.getAttribute('href')).toBe(`/conversation?id=${CHAT}&from=${seeded.ana.id}`);
    expect(card('About Ana').querySelector('a')!.getAttribute('href')).toBe(`/person?id=${seeded.ana.id}`);
    expect(card('group note').querySelector('a')!.getAttribute('href')).toContain(`id=${GROUP}`);
    expect(view!.container.querySelector('nav[aria-label="Sections"] [aria-current="page"]')!.textContent).toBe('Notes');
  });

  test('edits a note in place with the shared editor, and the card shows the new text', async () => {
    const lib = await open(<PersonNotesScreen />, writeAll);
    const c = card('About the chat');
    await click(button(c, t.edit));
    const field = c.querySelector('textarea')!;
    expect(field.value).toBe('About the chat');
    await type(field, 'About the chat, edited');
    await click(button(c, n.save));
    await settle();
    expect(await getNote(lib.deps, { kind: 'conversation', conversationId: CHAT })).toMatchObject({ body: 'About the chat, edited' });
    await click(button(c, n.close));
    expect(card('About the chat, edited')).toBeTruthy();
    expect(cards()).toHaveLength(4);
  });

  test('deleting a note asks first, then removes the card, lowers the count and says so', async () => {
    const lib = await open(<PersonNotesScreen />, writeAll);
    const c = card('group note');
    await click(button(c, t.edit));
    await click(button(c, n.delete));
    await click(button(c, n.deleteConfirm));
    await settle();
    expect(cards()).toHaveLength(3);
    expect(text()).toContain('3 notes about Ana M.');
    expect([...view!.container.querySelectorAll('[role="status"]')].map((e) => e.textContent)).toContain(n.deleted);
    expect(await countNotes(lib.deps, { profileId: seeded.ana.id })).toBe(3);
  });

  test('says there are no notes yet, and how to add one', async () => {
    await open(<PersonNotesScreen />);
    expect(text()).toContain('There are no notes about Ana M. yet.');
    expect(text()).toContain(t.emptyHint);
  });

  test('pages 50 at a time with Show more', async () => {
    const total = PERSON_NOTES_PAGE + 3;
    await open(<PersonNotesScreen />, async (lib) => {
      const rows = Array.from({ length: total }, (_, i) => msg({ sentAt: `2026-04-01T10:${String(i % 60).padStart(2, '0')}:00`, body: `bulk ${i}`, participantName: 'Bo' }));
      await load(lib, uuid(0x30), 'Bulk', seeded.ana.id, rows);
      const ids = (await lib.client.call('getMessageWindow', { conversationId: uuid(0x30), offset: 0, limit: 1000 })).map((m) => m.id);
      for (const id of ids) await setNote(lib.deps, { kind: 'message', conversationId: uuid(0x30), messageId: id }, `note ${id}`);
    });
    expect(cards()).toHaveLength(PERSON_NOTES_PAGE);
    expect(text()).toContain(`Showing ${PERSON_NOTES_PAGE} of ${total}`);
    await click(button(view!.container, t.showMore));
    await settle();
    expect(cards()).toHaveLength(total);
    expect(text()).not.toContain(t.showMore);
  });

  test('an unknown person is not-found, a failing read an error with Retry', async () => {
    await open(<PersonNotesScreen />);
    view!.unmount();
    search = 'id=00000000-0000-4000-8000-0000000000ff';
    view = await renderWithLibrary(<PersonNotesScreen />);
    await settle();
    expect(text()).toContain(en.person.notFoundTitle);
    view.unmount();

    const lib = await createTestLibrary();
    seeded = await seedNotes(lib);
    search = `id=${seeded.ana.id}`;
    let fail = true;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'listNotes' && fail ? Promise.reject(new Error('disk')) : call(method, params));
    view = await renderWithLibrary(<PersonNotesScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain(t.loadFailed);
    fail = false;
    await click(button(view.container, en.library.retry));
    await settle();
    expect(text()).toContain(t.empty.replace('{name}', 'Ana M.'));
  });

  test('is translated', async () => {
    await open(<PersonNotesScreen />, writeAll, ca);
    expect(view!.container.querySelector('h1')?.textContent).toBe(ca.personNotes.title);
    expect(text()).toContain(ca.personNotes.kind.message);
  });
});

describe('the note on a person page', () => {
  test('is a labelled editor that saves, shows when it was saved and lists in Notes', async () => {
    const lib = await open(<PersonScreen />);
    const field = view!.container.querySelector('textarea')!;
    expect(view!.container.querySelector(`label[for="${field.id}"]`)!.textContent).toBe(n.label.profile);
    expect(view!.container.querySelector('nav[aria-label="Sections"]')!.textContent).toContain('Notes');
    await type(field, 'Always laughed first.');
    await click(button(view!.container, n.save));
    await settle();
    expect(await getNote(lib.deps, { kind: 'profile', profileId: seeded.ana.id })).toMatchObject({ body: 'Always laughed first.' });
    expect(text()).toMatch(/Saved .* · /);
  });
});
