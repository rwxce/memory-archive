import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { NOTE_MAX } from '@/lib/domain/profile';
import { getNote, setNote } from '@/lib/usecases/notes';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from '@/hooks/use-library';
import { ConversationScreen } from './conversation-screen';
import { CHAT, HOSTILE, seedNotes, type Lib } from './notes-fixture';
import { MessageRow } from './message-row';
import { PersonTimelineScreen } from './person-timeline-screen';
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
  usePathname: () => '/sub',
}));

const n = en.notes;
let view: (Rendered & { lib: Lib }) | undefined;
let seeded: Awaited<ReturnType<typeof seedNotes>>;

async function open(ui: React.ReactNode, query: (personId: string) => string, messages?: Record<string, unknown>) {
  const lib = await createTestLibrary();
  seeded = await seedNotes(lib);
  search = query(seeded.ana.id);
  view = await renderWithLibrary(ui, { lib, messages });
  await settle();
  return lib;
}

const feed = () => view!.container.querySelector<HTMLElement>('[role="feed"]')!;
const articles = () => [...feed().querySelectorAll<HTMLElement>('article')];
const noteButton = (article: HTMLElement) => article.querySelector<HTMLButtonElement>('button[aria-label="Add a note"], button[aria-label="Edit note"]');
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const field = () => view!.container.querySelector<HTMLTextAreaElement>('textarea')!;
const button = (label: string) => [...view!.container.querySelectorAll('button')].find((b) => b.textContent === label)!;
const ctrlEnter = () => act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.getAttribute('role') === 'feed' ? 600 : 0; } });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  sessionStorage.clear();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('the note button on a message', () => {
  test('is a 44 px button on messages only, never on system or deleted notices', async () => {
    await open(<ConversationScreen />, () => `id=${CHAT}`);
    const [first, system, deleted, last] = articles();
    for (const article of [first, last]) {
      const b = noteButton(article)!;
      expect(b.getAttribute('aria-label')).toBe(n.addButton);
      expect(b.getAttribute('aria-expanded')).toBe('false');
      expect(b.className).toContain('size-11');
    }
    expect(noteButton(system)).toBeNull();
    expect(noteButton(deleted)).toBeNull();
  });

  test('opens a labelled editor under the message; Ctrl+Enter saves, the button changes and no row moves', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const tops = articles().map((a) => a.style.transform);
    await click(noteButton(articles()[0])!);
    await settle();
    expect(articles()[0].contains(field())).toBe(true);
    expect(field().getAttribute('dir')).toBe('auto');
    expect(view!.container.querySelector(`label[for="${field().id}"]`)!.textContent).toBe(n.label.message);
    expect(document.activeElement).toBe(field());
    await type(field(), 'She loved this song.\nSecond line');
    await ctrlEnter();
    await settle();
    expect(await getNote(lib.deps, { kind: 'message', conversationId: CHAT, messageId: seeded.chatIds[0] })).toMatchObject({ body: 'She loved this song.\nSecond line' });
    expect(noteButton(articles()[0])!.getAttribute('aria-label')).toBe(n.editButton);
    expect(noteButton(articles()[3])!.getAttribute('aria-label')).toBe(n.addButton);
    expect(articles()[0].textContent).toContain('Saved');
    expect(articles().map((a) => a.style.transform)).toEqual(tops);
  });

  test('a message with a note opens marked and shows its text, kept as typed (never as markup)', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    await setNote(lib.deps, { kind: 'message', conversationId: CHAT, messageId: seeded.chatIds[3] }, HOSTILE);
    view!.unmount();
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    expect(noteButton(articles()[3])!.getAttribute('aria-label')).toBe(n.editButton);
    await click(noteButton(articles()[3])!);
    await settle();
    expect(field().value).toBe(HOSTILE);
    expect(view!.container.querySelector('img')).toBeNull();
  });

  test('closing with unsaved text asks first; Keep editing returns to it, Discard drops it', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    await click(noteButton(articles()[0])!);
    await settle();
    await type(field(), 'half a thought');
    await click(button(n.cancel));
    expect(view!.container.textContent).toContain(n.discardBody);
    await click(button(n.discardKeep));
    expect(field().value).toBe('half a thought');
    await click(button(n.cancel));
    await click(button(n.discardConfirm));
    expect(view!.container.querySelector('textarea')).toBeNull();
    expect(await getNote(lib.deps, { kind: 'message', conversationId: CHAT, messageId: seeded.chatIds[0] })).toBeNull();
  });

  test('delete asks first, then removes the note and the mark', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const target = { kind: 'message', conversationId: CHAT, messageId: seeded.chatIds[0] } as const;
    await setNote(lib.deps, target, 'old');
    view!.unmount();
    view = await renderWithLibrary(<ConversationScreen />, { lib });
    await settle();
    await click(noteButton(articles()[0])!);
    await settle();
    await click(button(n.delete));
    await click(button(n.deleteKeep));
    expect(await getNote(lib.deps, target)).not.toBeNull();
    await click(button(n.delete));
    await click(button(n.deleteConfirm));
    await settle();
    expect(await getNote(lib.deps, target)).toBeNull();
    expect(noteButton(articles()[0])!.getAttribute('aria-label')).toBe(n.addButton);
    expect(field().value).toBe('');
  });

  test('a failed write keeps the text and says so; trying again saves it', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    let fail = true;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setNote' && fail ? Promise.reject(Object.assign(new Error('x'), { code: 'internal' })) : call(method, params));
    await click(noteButton(articles()[0])!);
    await settle();
    await type(field(), 'keep me');
    await click(button(n.save));
    await settle();
    expect(view!.container.querySelector('[role="alert"]')!.textContent).toBe(n.saveFailed);
    expect(field().value).toBe('keep me');
    fail = false;
    await click(button(n.save));
    await settle();
    expect(noteButton(articles()[0])!.getAttribute('aria-label')).toBe(n.editButton);
  });

  test('a text the archive refuses is explained next to the field', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setNote' ? Promise.reject(Object.assign(new Error('x'), { code: 'invalid' })) : call(method, params));
    await click(noteButton(articles()[0])!);
    await settle();
    await type(field(), 'x');
    await click(button(n.save));
    await settle();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(view!.container.textContent).toContain('The limit is 10,000 characters.');
  });

  test('the remaining-characters counter shows only near the limit', async () => {
    await open(<ConversationScreen />, () => `id=${CHAT}`);
    await click(noteButton(articles()[0])!);
    await settle();
    await type(field(), 'short');
    expect(view!.container.textContent).not.toContain('characters left');
    await type(field(), 'a'.repeat(NOTE_MAX - 10));
    expect(view!.container.textContent).toContain('10 characters left');
    expect(field().maxLength).toBe(NOTE_MAX);
  });

  test('on a person timeline the note is saved in the message\'s own conversation', async () => {
    const lib = await open(<PersonTimelineScreen />, (id) => `id=${id}&date=2026-03-17`);
    const rows = articles();
    await click(noteButton(rows[4])!);
    await settle();
    await type(field(), 'group note');
    await click(button(n.save));
    await settle();
    const group = (await lib.client.call('listNotes', { scope: undefined, offset: 0, limit: 10 }))[0];
    expect(group).toMatchObject({ kind: 'message', body: 'group note', conversationTitle: 'Group' });
    expect(noteButton(articles()[4])!.getAttribute('aria-label')).toBe(n.editButton);
  });

  test('the names are translated', async () => {
    await open(<ConversationScreen />, () => `id=${CHAT}`, ca);
    expect(noteButton(articles()[0])).toBeNull();
    expect(articles()[0].querySelector('button[aria-label="' + ca.notes.addButton + '"]')).not.toBeNull();
  });
});

/** A screen would open the library; this stands in for it. */
function Row(props: React.ComponentProps<typeof MessageRow>) {
  useLibrary();
  return <MessageRow {...props} />;
}

describe('a note typed but not saved', () => {
  test('survives its row being removed and shown again (a scrolled-away message)', async () => {
    const lib = await createTestLibrary();
    seeded = await seedNotes(lib);
    const message = (await lib.client.call('getMessageWindow', { conversationId: CHAT, offset: 0, limit: 1 }))[0];
    const drafts = new Map<string, string>();
    const props = { conversationId: CHAT, index: 0, count: 1, top: 0, message, previous: null, rowRef: () => {}, noteDrafts: drafts, onNoteChanged: vi.fn() };
    view = Object.assign(await renderWithLibrary(<Row {...props} />, { lib }), { lib });
    await settle();
    await click(noteButton(view.container.querySelector('article')!)!);
    await settle();
    await type(field(), 'not saved yet');
    expect(drafts.get(`${CHAT}:${message.id}`)).toBe('not saved yet');
    view.unmount();
    view = Object.assign(await renderWithLibrary(<Row {...props} />, { lib }), { lib });
    await settle();
    expect(field().value).toBe('not saved yet');
  });
});

describe('the note on a conversation', () => {
  test('is added from the header and the button then says Edit note', async () => {
    const lib = await open(<ConversationScreen />, () => `id=${CHAT}`);
    const header = view!.container.querySelector('header')!;
    const toggle = header.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-label')).toBe(n.addConversation);
    await click(toggle);
    await settle();
    expect(view!.container.querySelector(`label[for="${field().id}"]`)!.textContent).toBe(n.label.conversation);
    await type(field(), 'about this chat');
    await click(button(n.save));
    await settle();
    expect(await getNote(lib.deps, { kind: 'conversation', conversationId: CHAT })).toMatchObject({ body: 'about this chat' });
    expect(header.querySelector('button[aria-expanded]')!.getAttribute('aria-label')).toBe(n.editConversation);
  });
});
