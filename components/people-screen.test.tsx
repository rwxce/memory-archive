import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { DbError } from '@/lib/db/errors';
import { createConversation } from '@/lib/db/queries';
import { createTestLibrary, libraryOf } from '@/lib/usecases/test-client';
import { archiveProfile, createProfile } from '@/lib/usecases/profiles';
import { act } from 'react';
import { click, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { PeopleScreen } from './people-screen';
import { Welcome } from './welcome';

// The app header links through next-intl's navigation, which needs the Next.js router.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

type View = Rendered & Awaited<ReturnType<typeof renderWithLibrary>>;

const p = en.people;
/** Runs the provider's whole automatic "in use" backoff (about 8 s) on fake timers. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const buttonByText = (view: Rendered, text: string) =>
  [...view.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;
const buttonByLabel = (view: Rendered, label: string) => view.container.querySelector(`button[aria-label="${label}"]`);
/** Names of the people on screen (a collapsed Archived section is hidden, so not counted). */
const names = (view: Rendered) =>
  [...view.container.querySelectorAll('li h2, li h3')].filter((h) => !h.closest('[hidden]')).map((h) => h.textContent);
const status = (view: Rendered) => view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent;

async function open(seed?: (lib: View['lib']) => Promise<void>, props: Parameters<typeof PeopleScreen>[0] = {}): Promise<View> {
  const lib = await createTestLibrary();
  if (seed) await seed(lib);
  const view = await renderWithLibrary(<PeopleScreen {...props} />, { lib });
  await settle();
  return view;
}

describe('PeopleScreen', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('shows the empty state with a way to add the first person', async () => {
    view = await open();
    expect(view.container.querySelector('h1')?.textContent).toBe(p.title);
    expect(view.container.textContent).toContain(p.emptyTitle);
    expect(buttonByText(view, p.add)).not.toBeNull();
  });

  test('offers a way into the import wizard next to adding a person, also when no one is there yet', async () => {
    view = await open();
    const link = view.container.querySelector<HTMLAnchorElement>('a[href="/import"]');
    expect(link?.textContent).toBe(p.import);
    expect(buttonByText(view, p.add)).not.toBeNull();
  });

  test('lists active people with relationship and conversation count; archived stay hidden', async () => {
    view = await open(async ({ deps, opened }) => {
      const ana = await createProfile(deps, { displayName: 'Ana', relationship: 'mother' });
      const bo = await createProfile(deps, { displayName: 'Bo' });
      await archiveProfile(deps, bo.id);
      createConversation(opened.db, {
        id: '00000000-0000-4000-8000-0000000000a1',
        title: 'Chat',
        source: 'whatsapp',
        isGroup: false,
        profileIds: [ana.id],
        participants: [],
        now: '2026-03-01T10:00:00.000Z',
      });
    });
    expect(names(view)).toEqual(['Ana']);
    const card = view.container.querySelector('li')!;
    expect(card.textContent).toContain('mother');
    expect(card.textContent).toContain('1 conversation');
    const toggle = buttonByText(view, 'Show archived people (1)')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(names(view)).toEqual(['Ana', 'Bo']);
  });

  test('renders names as text, never as markup', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: '<img src=x onerror=alert(1)>' });
    });
    expect(view.container.querySelector('li img')).toBeNull();
    expect(names(view)).toEqual(['<img src=x onerror=alert(1)>']);
  });

  test('creates a person: the form validates, saves, returns to the list and announces it', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    expect(view.container.querySelector('h1')?.textContent).toBe(p.form.createTitle);
    const form = view.container.querySelector('form')!;
    const nameInput = form.querySelector('input')!;
    expect(document.activeElement).toBe(nameInput);

    await submit(form);
    expect(form.textContent).toContain(p.form.nameRequired);
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameInput);

    await type(nameInput, '  Carla  ');
    await type(form.querySelectorAll('input')[1], 'friend');
    await type(form.querySelector('textarea'), 'Met at school.');
    await submit(form);
    await settle();

    expect(names(view)).toEqual(['Carla']);
    expect(view.container.querySelector('li')!.textContent).toContain('friend');
    expect(status(view)).toBe('Carla was added.');
    const stored = await (view as View).lib.deps.client.call('listProfiles');
    expect(stored[0]).toMatchObject({ displayName: 'Carla', relationship: 'friend', description: 'Met at school.' });
  });

  test('rejects an over-long name next to the field and keeps what was typed', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'x'.repeat(101));
    await submit(form);
    expect(form.textContent).toContain('The name can have up to 100 characters.');
    expect(form.querySelector('input')!.value).toHaveLength(101);
    expect(await (view as View).lib.deps.client.call('listProfiles')).toEqual([]);
  });

  test('a failed save says nothing changed and keeps the form open', async () => {
    view = await open();
    (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Dani');
    await submit(form);
    await settle();
    expect(form.textContent).toContain(p.form.saveFailed);
    expect(view.container.querySelector('form')).not.toBeNull();
    expect(form.querySelector('input')!.value).toBe('Dani');
  });

  test('edits a person with their details filled in', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Eva', relationship: 'aunt' });
    });
    await click(buttonByLabel(view, 'Edit Eva'));
    expect(view.container.querySelector('h1')?.textContent).toBe('Edit Eva');
    const form = view.container.querySelector('form')!;
    expect(form.querySelector('input')!.value).toBe('Eva');
    await type(form.querySelector('input'), 'Eva Puig');
    await type(form.querySelectorAll('input')[1], '');
    await submit(form);
    await settle();
    expect(names(view)).toEqual(['Eva Puig']);
    expect(status(view)).toBe('Changes to Eva Puig were saved.');
    expect(view.container.querySelector('li')!.textContent).not.toContain('aunt');
  });

  test('cancelling a form changes nothing and gives focus back to the button that opened it', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    await click(buttonByText(view, p.form.cancel));
    await settle();
    expect(view.container.querySelector('form')).toBeNull();
    expect(names(view)).toEqual([]);
    expect(document.activeElement?.id).toBe('add-person');
  });

  test('archiving asks first, says what is kept, then moves the person to Archived', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Fina' });
    });
    await click(buttonByLabel(view, 'Archive Fina'));
    const group = view.container.querySelector('[role="group"]')!;
    expect(group.textContent).toContain('Archive Fina?');
    expect(group.textContent).toContain('conversations, messages and photos stay on this device');
    expect(document.activeElement).toBe(buttonByText(view, p.archiveConfirm.cancel));
    // Nothing happened yet.
    expect((await (view as View).lib.deps.client.call('listProfiles', { state: 'archived' })).length).toBe(0);

    await click(buttonByText(view, p.archiveConfirm.confirm));
    await settle();
    expect(names(view)).toEqual([]);
    expect(view.container.textContent).toContain(p.emptyTitle);
    expect(status(view)).toBe('Fina is now archived.');
    expect(view.container.textContent).toContain('Show archived people (1)');
  });

  test('keeping someone in the list leaves them untouched', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Gina' });
    });
    await click(buttonByLabel(view, 'Archive Gina'));
    await click(buttonByText(view, p.archiveConfirm.cancel));
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    expect(names(view)).toEqual(['Gina']);
  });

  test('restores an archived person to the main list', async () => {
    view = await open(async ({ deps }) => {
      const hugo = await createProfile(deps, { displayName: 'Hugo' });
      await archiveProfile(deps, hugo.id);
    });
    expect(view.container.textContent).toContain(p.allArchivedBody);
    await click(buttonByText(view, 'Show archived people (1)'));
    await click(buttonByLabel(view, 'Restore Hugo'));
    await settle();
    expect(status(view)).toBe('Hugo is back in the list.');
    expect(view.container.textContent).not.toContain('Show archived');
    expect(names(view)).toEqual(['Hugo']);
  });

  test('a failed archive says nothing changed', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Iris' });
    });
    await click(buttonByLabel(view, 'Archive Iris'));
    (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
    await click(buttonByText(view, p.archiveConfirm.confirm));
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Nothing was changed for Iris. Try again.');
    expect(names(view)).toEqual(['Iris']);
  });

  test('shows the welcome instead while the library has no profile at all', async () => {
    view = await open(undefined, { whenNoProfiles: <p>welcome-here</p> });
    expect(view.container.textContent).toBe('welcome-here');
  });

  test('shows People, not the welcome, once anyone exists (even only archived)', async () => {
    view = await open(
      async ({ deps }) => {
        const jo = await createProfile(deps, { displayName: 'Jo' });
        await archiveProfile(deps, jo.id);
      },
      { whenNoProfiles: <p>welcome-here</p> },
    );
    expect(view.container.textContent).not.toContain('welcome-here');
    expect(view.container.querySelector('h1')?.textContent).toBe(p.title);
  });

  test('keeps one status region mounted through the form, so created / updated are announced', async () => {
    view = await open();
    const region = view.container.querySelector('[role="status"][aria-live="polite"]');
    await click(buttonByText(view, p.add));
    expect(view.container.querySelector('[role="status"][aria-live="polite"]')).toBe(region);
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Kai');
    await submit(form);
    await settle();
    expect(view.container.querySelector('[role="status"][aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toBe('Kai was added.');
  });

  test('opening a form clears the previous message', async () => {
    view = await open(async ({ deps }) => {
      const lia = await createProfile(deps, { displayName: 'Lia' });
      await archiveProfile(deps, lia.id);
    });
    await click(buttonByText(view, 'Show archived people (1)'));
    await click(buttonByLabel(view, 'Restore Lia'));
    await settle();
    expect(status(view)).toBe('Lia is back in the list.');
    await click(buttonByLabel(view, 'Edit Lia'));
    expect(status(view)).toBe('');
  });

  test('after creating, the new list is on screen with no empty-state flash', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Mia');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(view!.container.textContent ?? ''));
    observer.observe(view.container, { childList: true, subtree: true, characterData: true });
    await submit(form);
    await settle();
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes(p.emptyTitle))).toBe(false);
    expect(names(view)).toEqual(['Mia']);
  });

  test('a double submit creates one person', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Noa');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(await (view as View).lib.deps.client.call('listProfiles')).toHaveLength(1);
  });

  test('Escape closes the form without saving, and the archive confirmation without archiving', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Ona' });
    });
    await click(buttonByLabel(view, 'Archive Ona'));
    const cancel = buttonByText(view, p.archiveConfirm.cancel)!;
    await act(async () => {
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(view.container.querySelector('[role="group"]')).toBeNull();
    expect(names(view)).toEqual(['Ona']);

    await click(buttonByText(view, p.add));
    const input = view.container.querySelector('form input')!;
    await type(input, 'Not saved');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(view.container.querySelector('form')).toBeNull();
    expect(names(view)).toEqual(['Ona']);
  });

  test('a failed archive keeps the confirmation open and focus on its button', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Pau' });
    });
    await click(buttonByLabel(view, 'Archive Pau'));
    (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
    const confirm = buttonByText(view, p.archiveConfirm.confirm)!;
    confirm.focus();
    await click(confirm);
    await settle();
    expect(view.container.querySelector('[role="group"]')).not.toBeNull();
    expect(document.activeElement).toBe(confirm);
  });

  test('people are h2 under the page h1; archived ones are h3 under their section', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Quim' });
      const rut = await createProfile(deps, { displayName: 'Rut' });
      await archiveProfile(deps, rut.id);
    });
    expect([...view.container.querySelectorAll('h1, h2, h3')].map((h) => `${h.tagName}:${h.textContent}`)).toEqual([
      'H1:People',
      'H2:Quim',
      'H2:Archived',
      'H3:Rut',
    ]);
  });

  test('the confirmation buttons read in the same order for the eye and for Tab', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Sol' });
    });
    await click(buttonByLabel(view, 'Archive Sol'));
    const row = buttonByText(view, p.archiveConfirm.cancel)!.parentElement!;
    expect(row.className).not.toContain('reverse');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([p.archiveConfirm.cancel, p.archiveConfirm.confirm]);
  });

  test('a form opened while focus is being restored keeps the focus', async () => {
    view = await open(async ({ deps }) => {
      const tom = await createProfile(deps, { displayName: 'Tom' });
      await archiveProfile(deps, tom.id);
    });
    await click(buttonByText(view, 'Show archived people (1)'));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await click(buttonByLabel(view, 'Restore Tom'));
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      // Restored; the focus restore is still waiting for its timer. Open a form first.
      await click(buttonByLabel(view, 'Edit Tom'));
      const input = view.container.querySelector('form input');
      expect(document.activeElement).toBe(input);
      await advance(10);
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Add a person is inert while a change is being saved', async () => {
    view = await open(async ({ deps }) => {
      await createProfile(deps, { displayName: 'Uri' });
    });
    await click(buttonByLabel(view, 'Archive Uri'));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = (view as View).lib.deps.client.call.bind((view as View).lib.deps.client);
    (view as View).lib.deps.client.call = async (op, ...args) => {
      await gate;
      return call(op, ...args);
    };
    await click(buttonByText(view, p.archiveConfirm.confirm));
    const add = buttonByText(view, p.add)!;
    expect(add.getAttribute('aria-disabled')).toBe('true');
    await click(add);
    expect(view.container.querySelector('form')).toBeNull();
    release();
    await settle();
    expect(add.getAttribute('aria-disabled')).toBeNull();
  });

  test('Escape during an input-method composition does not close the form', async () => {
    view = await open();
    await click(buttonByText(view, p.add));
    const input = view.container.querySelector('form input')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
    });
    expect(view.container.querySelector('form')).not.toBeNull();
    await act(async () => {
      const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      input.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
      input.dispatchEvent(handled);
    });
    expect(view.container.querySelector('form')).not.toBeNull();
  });

  test('after a failed save focus stays in the form, on the Save button, which never became disabled', async () => {
    view = await open();
    (view as View).lib.deps.client.call = () => Promise.reject(new DbError('internal', 'boom'));
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Vera');
    const save = buttonByText(view, p.form.create)!;
    await submit(form);
    await settle();
    expect(form.textContent).toContain(p.form.saveFailed);
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(save);
  });

  test('keeps the welcome reachable from People', async () => {
    view = await open();
    const link = [...view.container.querySelectorAll('a')].find((a) => a.textContent === p.about);
    expect(link?.getAttribute('href')).toBe('/welcome');
  });
  test('a name links to the person page', async () => {
    let id = '';
    view = await open(async ({ deps }) => {
      id = (await createProfile(deps, { displayName: 'Ana' })).id;
    });
    const link = view.container.querySelector('li h2 a')!;
    expect(link.getAttribute('href')).toBe(`/person?id=${id}`);
    expect(link.textContent).toBe('Ana');
    // Edit and Archive stay on the card.
    expect(buttonByLabel(view, 'Edit Ana')).not.toBeNull();
    expect(buttonByLabel(view, 'Archive Ana')).not.toBeNull();
  });

  describe('conversations that belong to no one', () => {
    const chat = '00000000-0000-4000-8000-0000000000c1';
    const group = '00000000-0000-4000-8000-0000000000c2';
    const seedUnassigned = async ({ deps, client }: View['lib']) => {
      await createProfile(deps, { displayName: 'Ana' });
      await client.call('createConversation', { id: chat, title: 'Old chat', source: 'whatsapp', isGroup: false, profileIds: [], participants: [{ displayName: 'Zed', profileId: null }], now: '2026-03-01T10:00:00.000Z' });
      await client.call('createConversation', { id: group, title: 'Old group', source: 'whatsapp', isGroup: true, profileIds: [], participants: [], now: '2026-03-01T10:00:00.000Z' });
    };
    const section = (v: Rendered) => [...v.container.querySelectorAll('section')].find((x) => x.querySelector('h2')?.textContent === p.unassignedTitle);

    test('are listed under "Not assigned to anyone yet", and the section is absent when there are none', async () => {
      view = await open(async ({ deps }) => void (await createProfile(deps, { displayName: 'Ana' })));
      expect(section(view)).toBeUndefined();
      view.unmount();
      view = await open(seedUnassigned);
      expect([...section(view)!.querySelectorAll('li h3')].map((h) => h.textContent)).toEqual(['Old chat', 'Old group']);
      expect(section(view)!.textContent).toContain(en.conversations.group);
      expect(section(view)!.textContent).toContain('With Zed');
      // The people list itself still holds only people.
      expect([...view.container.querySelectorAll('li h2')].map((h) => h.textContent)).toEqual(['Ana']);
    });

    test('are shown even when there is no one yet, instead of the welcome', async () => {
      view = await open(
        async ({ client }) => {
          await client.call('createConversation', { id: chat, title: 'Old chat', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: '2026-03-01T10:00:00.000Z' });
        },
        { whenNoProfiles: <p>welcome-here</p> },
      );
      expect(view.container.textContent).not.toContain('welcome-here');
      expect(section(view)).toBeDefined();
    });

    test('can be assigned to a person; focus goes to the section while others remain, then to the title', async () => {
      view = await open(seedUnassigned);
      await click(buttonByLabel(view, 'Assign to…: “Old chat”'));
      const select = view.container.querySelector('select')!;
      expect(document.activeElement).toBe(select);
      await act(async () => {
        select.value = (await (view as View).lib.deps.client.call('listProfiles'))[0].id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await submit(view.container.querySelector('form'));
      await settle();
      expect(status(view)).toBe('“Old chat” now belongs to Ana. The messages were not changed.');
      expect([...section(view)!.querySelectorAll('li h3')].map((h) => h.textContent)).toEqual(['Old group']);
      expect(view.container.querySelector('li')!.textContent).toContain('1 conversation');
      expect(document.activeElement).toBe(section(view)!.querySelector('h2'));

      await click(buttonByLabel(view, 'Assign to…: “Old group”'));
      await act(async () => {
        const again = view!.container.querySelector('select')!;
        again.value = (await (view as View).lib.deps.client.call('listProfiles'))[0].id;
        again.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await submit(view.container.querySelector('form'));
      await settle();
      expect(section(view)).toBeUndefined();
      expect(document.activeElement).toBe(view.container.querySelector('h1'));
    });

    test('can be renamed in place and cannot be assigned to no one', async () => {
      view = await open(seedUnassigned);
      await click(buttonByLabel(view, 'Assign to…: “Old chat”'));
      await submit(view.container.querySelector('form'));
      expect([...view.container.querySelectorAll('[role="alert"]')].map((a) => a.textContent)).toContain(en.conversations.pick.required);
      await click(buttonByText(view, en.conversations.pick.cancel));
      await settle();
      await click(buttonByLabel(view, 'Rename “Old chat”'));
      await type(view.container.querySelector('form input'), 'Kept chat');
      await submit(view.container.querySelector('form'));
      await settle();
      expect(status(view)).toBe('Renamed to “Kept chat”.');
      expect([...section(view)!.querySelectorAll('li h3')].map((h) => h.textContent)).toEqual(['Kept chat', 'Old group']);
    });
  });
});

describe('Home when the library cannot open on first run', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    vi.useRealTimers();
  });

  test('still shows the welcome, with the reason beneath it and a way to retry', async () => {
    vi.useFakeTimers();
    let fail = true;
    const lib = await createTestLibrary();
    view = await renderWithLibrary(<PeopleScreen whenNoProfiles={<Welcome />} />, {
      open: async () => {
        if (fail) throw new DbError('unavailable', 'held');
        return libraryOf(lib.deps);
      },
    });
    await advance(8000);
    const text = view.container.textContent ?? '';
    expect(text).toContain(en.welcome.title);
    expect(text).toContain(en.welcome.privacy);
    expect([...view.container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([en.welcome.start, en.welcome.open, en.library.retry]);
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(en.library.inUse.title);
    expect(alert.textContent).toContain('another tab or window');
    // Beneath the welcome, not instead of it.
    expect(view.container.querySelector('main')!.lastElementChild).toBe(alert);

    fail = false;
    await click(buttonByText(view, en.library.retry));
    await advance(0);
    expect(view.container.textContent).toContain(en.welcome.title);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });

  test('shows the welcome with the error notice after an unexpected failure', async () => {
    view = await renderWithLibrary(<PeopleScreen whenNoProfiles={<Welcome />} />, { open: async () => Promise.reject(new DbError('internal', 'x')) });
    await settle();
    expect(view.container.textContent).toContain(en.welcome.title);
    expect(view.container.textContent).toContain(en.library.error.body);
  });

  test('while loading it shows a neutral shell with the same spacing as the welcome, not the welcome', async () => {
    view = await renderWithLibrary(<PeopleScreen whenNoProfiles={<Welcome />} />, { open: () => new Promise(() => {}) });
    expect(view.container.textContent).not.toContain(en.welcome.title);
    expect(view.container.querySelector('main')!.className).toContain('pt-10');
    expect(view.container.querySelector('main')!.className).toContain('sm:pt-20');
  });
});

describe('PeopleScreen when the library cannot open', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    vi.useRealTimers();
  });

  test('explains that another tab holds it, and offers to try again', async () => {
    vi.useFakeTimers();
    let fail = true;
    const lib = await createTestLibrary();
    view = await renderWithLibrary(<PeopleScreen />, {
      open: async () => {
        if (fail) throw new DbError('unavailable', 'held');
        return libraryOf(lib.deps);
      },
    });
    await advance(8000);
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(en.library.inUse.title);
    expect(view.container.querySelector('h1')).toBeNull();

    fail = false;
    await click(buttonByText(view, en.library.retry));
    await advance(0);
    expect(view.container.querySelector('h1')?.textContent).toBe(p.title);
  });

  test('says nothing was deleted on an unexpected error', async () => {
    view = await renderWithLibrary(<PeopleScreen />, { open: async () => Promise.reject(new DbError('internal', 'x')) });
    await settle();
    expect(view.container.textContent).toContain(en.library.error.body);
  });

  test('explains a library saved by a newer version', async () => {
    view = await renderWithLibrary(<PeopleScreen />, { open: async () => Promise.reject(new DbError('newer-schema', 'x')) });
    await settle();
    expect(view.container.textContent).toContain(en.library.newerVersion.title);
  });

  test('shows a calm loading state while it opens', async () => {
    view = await renderWithLibrary(<PeopleScreen />, { open: () => new Promise(() => {}) });
    expect([...view.container.querySelectorAll('[role="status"]')].map((e) => e.textContent)).toContain(en.library.loading);
    expect(view.container.textContent).toContain(p.about);
  });
});
