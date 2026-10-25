import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { DbError } from '@/lib/db/errors';
import type { NewMessage } from '@/lib/domain/library';
import { listPeople } from '@/lib/usecases/library';
import { archiveProfile, createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { PersonScreen } from './person-screen';

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
// The app header links through next-intl's navigation, which needs the Next.js router.
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

const c = en.conversations;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-02-01T12:00:00.000Z';
const PRIVATE = uuid(0x10);
const GROUP = uuid(0x11);

const message = (n: number): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2025-0${n}-1${n}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: n % 2 ? 'Ana' : 'Bo',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
});

/** Ana (active, mother), Bo (active), Cy (active), Dee (archived); a private chat with Ana, a group with Ana and Bo. */
async function seed({ deps, client }: Lib) {
  const ana = await createProfile(deps, { displayName: 'Ana', relationship: 'mother', description: 'Line one\nLine two' });
  const bo = await createProfile(deps, { displayName: 'Bo' });
  const cy = await createProfile(deps, { displayName: 'Cy' });
  const dee = await createProfile(deps, { displayName: 'Dee' });
  await archiveProfile(deps, dee.id);
  await client.call('createConversation', { id: PRIVATE, title: 'Chat with Ana', source: 'whatsapp', isGroup: false, profileIds: [ana.id], participants: [{ displayName: 'Ana', profileId: ana.id }], now: NOW });
  await client.call('createConversation', {
    id: GROUP,
    title: 'Family group',
    source: 'whatsapp',
    isGroup: true,
    profileIds: [ana.id, bo.id],
    participants: ['Ana', 'Bo', 'Eve', 'Fay', 'Gus'].map((displayName) => ({ displayName, profileId: null })),
    now: NOW,
  });
  for (const [conversationId, n] of [[PRIVATE, 1], [GROUP, 2]] as const) {
    await client.call('importMessages', { batchId: uuid(0x100 + n), conversationId, source: 'whatsapp', sourceLabel: 'x.zip', now: NOW, blobs: [], messages: [message(n), message(n + 1)] });
  }
  return { ana, bo, cy, dee };
}

async function open(personId: string | null, prepare?: (lib: Lib) => Promise<void>, messages?: Record<string, unknown>): Promise<View> {
  const lib = await createTestLibrary();
  const people = await seed(lib);
  await prepare?.(lib);
  search = personId === null ? '' : `id=${personId === 'ana' ? people.ana.id : personId}`;
  const view = await renderWithLibrary(<PersonScreen />, { lib, messages });
  await settle();
  return view;
}

const buttonByLabel = (view: Rendered, label: string) => view.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const buttonByText = (view: Rendered, text: string) =>
  [...view.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;
const menuButton = (view: Rendered) => view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menuItems = (view: Rendered) => [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** Opens the "..." menu and presses the item with this name. */
const pick = async (view: Rendered, label: string) => {
  await click(menuButton(view));
  await click(menuItems(view).find((item) => item.textContent?.trim() === label));
};
const status = (view: Rendered) => view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent;
/** Text of the first alert that says something (empty alerts are always in the DOM). */
const alertText = (view: Rendered, within = '') =>
  [...view.container.querySelectorAll(`${within} [role="alert"]`)].map((el) => el.textContent).find(Boolean);
const titles = (view: Rendered) => [...view.container.querySelectorAll('li h3')].map((h) => h.textContent);
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const escape = (el: Element, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init }));
  });

describe('PersonScreen', () => {
  let view: View | undefined;
  beforeEach(() => {
    search = '';
  });
  afterEach(() => view?.unmount());

  test('every conversation title links to its view, and remembers which person to go back to', async () => {
    view = await open('ana');
    const links = [...view.container.querySelectorAll<HTMLAnchorElement>('li h3 a')];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([c.openLabel.replace('{title}', 'Chat with Ana'), c.openLabel.replace('{title}', 'Family group')]);
    const personId = new URLSearchParams(search).get('id');
    expect(links[0].getAttribute('href')).toBe(`/conversation?id=${PRIVATE}&from=${personId}`);
  });

  test('the bento leads to the sections (Timeline, Gallery, Audio, Favorites, Notes, Highlights) with the person in the address', async () => {
    view = await open('ana');
    const nav = view.container.querySelector('nav[aria-label="Sections"]')!;
    const links = [...nav.querySelectorAll('a')];
    const id = new URLSearchParams(search).get('id');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/person/timeline?id=${id}`, `/person/gallery?id=${id}`, `/person/audio?id=${id}`, `/person/favorites?id=${id}`, `/person/notes?id=${id}`, `/person/highlights?id=${id}`]);
    for (const [link, name] of links.map((l, i) => [l, ['Timeline', 'Gallery', 'Audio', 'Favorites', 'Notes', 'Highlights'][i]] as const)) expect(link.textContent).toContain(name);
  });

  test('the stats and the card hints come from the archive: messages, photos and videos, voice messages', async () => {
    view = await open('ana');
    const stats = [...view.container.querySelectorAll('dl > div')].map((d) => d.textContent);
    expect(stats).toEqual(['messages4', 'photos and videos0', 'voice messages0']);
    expect(view.container.textContent).toContain('0 photos and videos');
    expect(view.container.textContent).toContain('0 voice messages');
    // the timeline card draws one bar per year of messages
    expect(view.container.querySelectorAll('nav[aria-label="Sections"] a:first-child [aria-hidden] > div').length).toBe(1);
  });

  test('the description is the quote card and the meta line says since when', async () => {
    view = await open('ana');
    const quote = [...view.container.querySelectorAll('main p')].find((p) => p.textContent?.includes('Line one'))!;
    expect(quote.className).toContain('italic');
    expect(view.container.querySelector('main header')?.textContent).toContain('mother · since 2025');
  });

  test('the menu holds edit, archive, the person note, search and imports', async () => {
    view = await open('ana');
    expect(menuItems(view)).toHaveLength(0);
    await click(menuButton(view));
    expect(menuButton(view).getAttribute('aria-expanded')).toBe('true');
    expect(menuItems(view).map((i) => i.textContent?.trim())).toEqual(['Edit Ana', 'Archive Ana', en.person.menuNote, 'Search in Ana', en.person.importsLink]);
    expect(menuItems(view).at(-1)!.getAttribute('href')).toMatch(/^\/import\/history\?person=/);
  });

  test('menu keyboard: arrows move, Escape closes and gives focus back to the button', async () => {
    view = await open('ana');
    await click(menuButton(view));
    expect(document.activeElement).toBe(menuItems(view)[0]);
    const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuItems(view)[1]);
    await key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(menuItems(view).at(-1));
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuItems(view)[0]);
    await key(document.activeElement!, 'Escape');
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton(view));
  });

  test('the person note opens from the menu and closes again', async () => {
    view = await open('ana');
    expect(view.container.querySelector('textarea')).toBeNull();
    await pick(view, en.person.menuNote);
    await settle();
    expect(view.container.querySelector('textarea')).not.toBeNull();
    await click(buttonByText(view, en.notes.close));
    expect(view.container.querySelector('textarea')).toBeNull();
  });

  test('shows the person and their conversations: group badge, counts, dates, participants, other people', async () => {
    view = await open('ana');
    expect(view.container.querySelector('h1')?.textContent).toBe('Ana');
    expect(view.container.querySelector('main header')?.textContent).toContain('mother');
    expect(view.container.textContent).toContain('Line one');
    expect(view.container.querySelector('#person-conversations')?.textContent).toBe(en.person.conversationsTitle);
    expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
    const [privateChat, group] = [...view.container.querySelectorAll('ul[aria-label] > li')];
    expect(privateChat.textContent).toContain('2 messages');
    expect(privateChat.textContent).toContain('Jan 11, 2025 – Feb 12, 2025');
    expect(privateChat.textContent).toContain('With Ana');
    // The group is labelled as a group and never as a private chat; participants are summarised.
    expect(group.textContent).toContain(c.group);
    expect(privateChat.textContent).not.toContain(c.group);
    expect(group.textContent).toContain('With Ana, Bo, Eve and 2 others');
    expect(group.textContent).toContain('Also kept under Bo');
    expect(privateChat.textContent).toContain(c.privateChat);
    expect(view.container.querySelector('a[href="/people"]')).not.toBeNull();
    await click(menuButton(view));
    expect(view.container.querySelector('a[href^="/import/history?person="]')?.textContent?.trim()).toBe(en.person.importsLink);
  });

  test('renders in Catalan too (plural, quotes, list of names)', async () => {
    view = await open('ana', undefined, ca);
    expect(view.container.textContent).toContain('2 missatges');
    expect(view.container.textContent).toContain('Xat de grup');
    expect(view.container.textContent).toContain('i 2 persones més');
  });

  test('an unknown, malformed or missing id is a calm not-found with the way back', async () => {
    for (const id of [uuid(0x999), 'not-a-uuid', null]) {
      view = await open(id);
      expect(view.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
      expect(view.container.textContent).toContain('Nothing was deleted');
      expect(view.container.querySelector('a[href="/people"]')?.textContent).toBe(en.nav.tabs.people);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      view.unmount();
    }
    view = undefined;
  });

  test('every labelled button starts with its visible text (label in name)', async () => {
    view = await open('ana');
    const labelled = [...view.container.querySelectorAll('ul[aria-label] button[aria-label]')];
    expect(labelled.length).toBeGreaterThanOrEqual(6);
    for (const button of labelled) expect(button.getAttribute('aria-label')!.startsWith(button.textContent!.trim())).toBe(true);
  });

  test('a person with no conversations says so plainly', async () => {
    view = await open(uuid(3));
    expect(view.container.querySelector('h1')?.textContent).toBe('Cy');
    expect(view.container.textContent).toContain('No conversations are kept under Cy yet');
    expect(view.container.querySelector('ul[aria-label]')).toBeNull();
  });

  test('an archived person shows the badge and the conversations, and can be restored', async () => {
    view = await open(uuid(4), async ({ client }) => {
      await client.call('linkConversationProfile', { conversationId: GROUP, profileId: uuid(4) });
    });
    expect(view.container.querySelector('h1')?.textContent).toBe('Dee');
    expect(view.container.textContent).toContain(en.person.archivedBadge);
    expect(view.container.textContent).toContain(en.person.archivedNote);
    expect(titles(view)).toEqual(['Family group']);
    await click(menuButton(view));
    expect(menuItems(view).some((i) => i.textContent?.trim() === 'Archive Dee')).toBe(false);
    await click(menuButton(view));
    await pick(view, 'Restore Dee');
    await settle();
    expect(status(view)).toBe('Dee is back in the list.');
    expect(view.container.textContent).not.toContain(en.person.archivedBadge);
    await click(menuButton(view));
    expect(menuItems(view).some((i) => i.textContent?.trim() === 'Archive Dee')).toBe(true);
  });

  test('edit reuses the form, announces the change and gives focus back to the menu button', async () => {
    view = await open('ana');
    await pick(view, 'Edit Ana');
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Ana Puig');
    await submit(form);
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('Ana Puig');
    expect(status(view)).toBe('Changes to Ana Puig were saved.');
    // Focus returns to the menu button after the form closes: wait for it, a slow runner is late.
    const shown = view;
    await vi.waitFor(() => expect(document.activeElement).toBe(menuButton(shown)), { timeout: 3000 });
  });

  test('archiving asks first; the person stays on the page, now archived, with focus on the menu button', async () => {
    view = await open('ana');
    await pick(view, 'Archive Ana');
    expect(view.container.querySelector('[role="group"]')?.textContent).toContain('conversations, messages and photos stay');
    expect(document.activeElement).toBe(buttonByText(view, en.people.archiveConfirm.cancel));
    await click(buttonByText(view, en.people.archiveConfirm.confirm));
    await settle();
    expect(status(view)).toBe('Ana is now archived.');
    expect(view.container.textContent).toContain(en.person.archivedBadge);
    expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
    await vi.waitFor(() => expect(document.activeElement).toBe(menuButton(view!)), { timeout: 3000 });
  });

  test('Escape on the archive question cancels it, and a failed archive keeps it open', async () => {
    view = await open('ana');
    await pick(view, 'Archive Ana');
    const cancel = buttonByText(view, en.people.archiveConfirm.cancel)!;
    await act(async () => void cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    await pick(view, 'Archive Ana');
    (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
    const confirm = buttonByText(view, en.people.archiveConfirm.confirm)!;
    confirm.focus();
    await click(confirm);
    await settle();
    expect(alertText(view)).toBe('Nothing was changed for Ana. Try again.');
    expect(view.container.querySelector('[role="group"]')).not.toBeNull();
    expect(document.activeElement).toBe(confirm);
    expect(view.container.querySelector('button[aria-label="Open"]')).toBeNull();
  });

  describe('rename', () => {
    test('validates like profiles, keeps the form open and puts focus on the field', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Rename “Family group”'));
      const input = view.container.querySelector<HTMLInputElement>('form input')!;
      expect(document.activeElement).toBe(input);
      await type(input, '   ');
      await submit(view.container.querySelector('form'));
      expect(alertText(view, 'form')).toBe(c.renameForm.required);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input);
      await type(input, 'x'.repeat(201));
      await submit(view.container.querySelector('form'));
      expect(alertText(view, 'form')).toBe('The name can have up to 200 characters.');
      expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
    });

    test('saves the trimmed name, announces it and gives focus back to Rename', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Rename “Family group”'));
      await type(view.container.querySelector('form input'), '  Family  ');
      await submit(view.container.querySelector('form'));
      await settle();
      expect(titles(view)).toEqual(['Chat with Ana', 'Family']);
      expect(status(view)).toBe('Renamed to “Family”.');
      expect(view.container.querySelector('form')).toBeNull();
      expect(document.activeElement).toBe(buttonByLabel(view, 'Rename “Family”'));
    });

    test('a double submit renames once', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Rename “Chat with Ana”'));
      const form = view.container.querySelector('form')!;
      await type(form.querySelector('input'), 'Mum');
      const call = vi.spyOn((view as View).lib.deps.client, 'call');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle();
      expect(call.mock.calls.filter(([name]) => name === 'renameConversation')).toHaveLength(1);
    });

    test('a failed save keeps the text and says nothing changed', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Rename “Family group”'));
      const input = view.container.querySelector<HTMLInputElement>('form input')!;
      await type(input, 'Kept text');
      (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
      await submit(view.container.querySelector('form'));
      await settle();
      expect(input.value).toBe('Kept text');
      expect(view.container.textContent).toContain(c.renameForm.failed);
      // Announced once: by the form's own alert, not also by a list-level one.
      const said = [...view.container.querySelectorAll('[role="alert"]')].map((el) => el.textContent).filter(Boolean);
      expect(said).toEqual([c.renameForm.failed]);
      expect(document.activeElement).toBe(input);
    });

    test('Escape cancels, but not while an input method is composing', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Rename “Family group”'));
      const input = view.container.querySelector('form input')!;
      await escape(input, { isComposing: true });
      expect(view.container.querySelector('form')).not.toBeNull();
      await escape(input);
      await settle();
      expect(view.container.querySelector('form')).toBeNull();
      expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
      expect(document.activeElement).toBe(buttonByLabel(view, 'Rename “Family group”'));
    });
  });

  describe('move', () => {
    test('lists the other active people first and archived ones apart, and needs a choice', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Move to another person: “Chat with Ana”'));
      const select = view.container.querySelector('select')!;
      expect(document.activeElement).toBe(select);
      expect([...select.querySelectorAll(':scope > option')].map((o) => o.textContent)).toEqual([c.pick.choose, 'Bo', 'Cy']);
      expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([c.pick.archivedGroup]);
      expect(view.container.querySelector('form')?.textContent).toContain('The messages stay exactly as they are');
      await submit(view.container.querySelector('form'));
      expect(alertText(view, 'form')).toBe(c.pick.required);
      expect(select.getAttribute('aria-invalid')).toBe('true');
    });

    test('moves without touching messages; the chat leaves this list and focus goes to the heading', async () => {
      view = await open('ana');
      const { lib } = view as View;
      const before = lib.opened.db.all('SELECT * FROM messages ORDER BY id');
      await click(buttonByLabel(view, 'Move to another person: “Chat with Ana”'));
      await choose(view.container.querySelector('select')!, uuid(3));
      await submit(view.container.querySelector('form'));
      await settle();
      expect(titles(view)).toEqual(['Family group']);
      expect(status(view)).toBe('“Chat with Ana” now belongs to Cy. The messages were not changed.');
      expect(document.activeElement).toBe(view.container.querySelector('#person-conversations'));
      expect(lib.opened.db.all('SELECT * FROM messages ORDER BY id')).toEqual(before);
      expect((await lib.client.call('listConversations', { profileId: uuid(3) })).map((x) => x.title)).toEqual(['Chat with Ana']);
    });

    test('a group chat moves as a group chat and states so', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Move to another person: “Family group”'));
      expect(view.container.querySelector('form')?.textContent).toContain('It stays a group chat');
      // Bo already has it: only people who do not are offered.
      expect([...view.container.querySelectorAll('select option')].map((o) => o.textContent)).toEqual([c.pick.choose, 'Cy', 'Dee']);
      await choose(view.container.querySelector('select')!, uuid(4));
      await submit(view.container.querySelector('form'));
      await settle();
      const [group] = await (view as View).lib.client.call('listConversations', { profileId: uuid(4) });
      expect(group).toMatchObject({ title: 'Family group', isGroup: true });
      expect(group.profileIds.sort()).toEqual([uuid(2), uuid(4)]);
    });

    test('with nobody to choose it says so', async () => {
      view = await open('ana', async ({ client }) => {
        for (const id of [uuid(3), uuid(4)]) await client.call('linkConversationProfile', { conversationId: PRIVATE, profileId: id });
        await client.call('linkConversationProfile', { conversationId: PRIVATE, profileId: uuid(2) });
      });
      await click(buttonByLabel(view, 'Move to another person: “Chat with Ana”'));
      expect(view.container.querySelector('select')).toBeNull();
      expect(view.container.textContent).toContain(c.pick.nobody);
      expect(buttonByText(view, c.pick.moveConfirm)).toBeNull();
      // No select to focus: focus goes to Cancel, the label points at nothing, Escape still closes.
      expect(document.activeElement).toBe(buttonByText(view, c.pick.cancel));
      expect(view.container.querySelector('form label')?.hasAttribute('for')).toBe(false);
      await escape(buttonByText(view, c.pick.cancel)!);
      await settle();
      expect(view.container.querySelector('form')).toBeNull();
      expect(document.activeElement).toBe(buttonByLabel(view, 'Move to another person: “Chat with Ana”'));
    });
  });

  describe('link and unlink', () => {
    test('a private chat can be moved and renamed, but not linked or unlinked', async () => {
      view = await open('ana');
      const card = view.container.querySelector('ul[aria-label] > li')!;
      expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual([c.rename, c.move]);
    });

    test('also links a group chat to another person and says nothing is copied', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Also keep under…: “Family group”'));
      expect(view.container.querySelector('form')?.textContent).toContain('only one copy');
      expect([...view.container.querySelectorAll('select option')].map((o) => o.textContent)).toEqual([c.pick.choose, 'Cy', 'Dee']);
      await choose(view.container.querySelector('select')!, uuid(3));
      await submit(view.container.querySelector('form'));
      await settle();
      expect(status(view)).toBe('“Family group” is now also kept under Cy. The messages were not changed.');
      expect(view.container.textContent).toContain('Also kept under Bo, Cy');
      expect(document.activeElement).toBe(buttonByLabel(view, 'Also keep under…: “Family group”'));
      expect((await (view as View).lib.client.call('listConversations', { profileId: uuid(3) })).map((x) => x.title)).toEqual(['Family group']);
    });

    test('unlinking asks first, keeps the chat for the others and moves focus to the heading', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      const group = view.container.querySelector('[role="group"]')!;
      expect(group.textContent).toContain('Unlink “Family group” from Ana?');
      expect(group.textContent).toContain('messages stay exactly as they are');
      expect(document.activeElement).toBe(buttonByText(view, c.unlinkConfirm.cancel));
      // Nothing happened yet.
      expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
      await click(buttonByText(view, c.unlinkConfirm.confirm));
      await settle();
      expect(titles(view)).toEqual(['Chat with Ana']);
      expect(status(view)).toBe('“Family group” is no longer kept under Ana. The messages stay as they are.');
      expect(document.activeElement).toBe(view.container.querySelector('#person-conversations'));
      expect((await (view as View).lib.client.call('listConversations', { profileId: uuid(2) })).map((x) => x.title)).toEqual(['Family group']);
    });

    test('unlinking the last person leaves the chat unassigned, says so, and it shows on People', async () => {
      view = await open('ana', async ({ client }) => {
        await client.call('unlinkConversationProfile', { conversationId: GROUP, profileId: uuid(2) });
      });
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      expect(view.container.querySelector('[role="group"]')?.textContent).toContain('not assigned to anyone yet');
      await click(buttonByText(view, c.unlinkConfirm.confirm));
      await settle();
      expect(status(view)).toBe('“Family group” is no longer kept under Ana. It is still in your archive, not assigned to anyone yet.');
      const { unassigned } = await listPeople((view as View).lib.deps);
      expect(unassigned.map((x) => [x.title, x.isGroup, x.messageCount])).toEqual([['Family group', true, 2]]);
    });

    test('cancelling or Escape changes nothing', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      await click(buttonByText(view, c.unlinkConfirm.cancel));
      await settle();
      expect(document.activeElement).toBe(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      await escape(buttonByText(view, c.unlinkConfirm.cancel)!);
      expect(view.container.querySelector('[role="group"]')).toBeNull();
      expect(titles(view)).toEqual(['Chat with Ana', 'Family group']);
    });

    test('a failed change says nothing changed and keeps the panel open', async () => {
      view = await open('ana');
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
      const confirm = buttonByText(view, c.unlinkConfirm.confirm)!;
      confirm.focus();
      await click(confirm);
      await settle();
      expect(view.container.querySelector('[role="group"] [role="alert"]')?.textContent).toBe('Nothing was changed for “Family group”. Try again.');
      expect([...view.container.querySelectorAll('[role="alert"]')].filter((el) => el.textContent)).toHaveLength(1);
      expect(view.container.querySelector('[role="group"]')).not.toBeNull();
      expect(document.activeElement).toBe(confirm);
      // Cancelling clears it: reopening shows no stale error.
      await click(buttonByText(view, c.unlinkConfirm.cancel));
      await settle();
      expect(alertText(view)).toBeUndefined();
      await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
      expect(alertText(view)).toBeUndefined();
    });
  });

  test('while a change is running the other buttons do nothing (aria-disabled, focus kept)', async () => {
    view = await open('ana');
    const { lib } = view as View;
    let release: () => void = () => {};
    const real = lib.deps.client.call.bind(lib.deps.client);
    lib.deps.client.call = ((name: string, params: unknown) =>
      name === 'unlinkConversationProfile' ? new Promise((resolve) => (release = () => resolve(real(name as 'status', params as never)))) : real(name as 'status', params as never)) as typeof lib.deps.client.call;
    await click(buttonByLabel(view, 'Unlink “Family group” from Ana'));
    await click(buttonByText(view, c.unlinkConfirm.confirm));
    expect(buttonByText(view, c.unlinkConfirm.cancel)?.getAttribute('aria-disabled')).toBe('true');
    await click(buttonByText(view, c.unlinkConfirm.cancel));
    expect(view.container.querySelector('[role="group"]')).not.toBeNull();
    await act(async () => release());
    await settle();
    expect(titles(view)).toEqual(['Chat with Ana']);
  });

  test('one status region stays mounted through every state', async () => {
    view = await open('ana');
    const region = view.container.querySelector('[role="status"][aria-live="polite"]');
    await pick(view, 'Edit Ana');
    expect(view.container.querySelector('[role="status"][aria-live="polite"]')).toBe(region);
  });
});
