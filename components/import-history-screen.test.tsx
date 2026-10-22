import { act } from 'react';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { DbError } from '@/lib/db/errors';
import { importMessages } from '@/lib/db/queries';
import { importWhatsAppExport } from '@/lib/usecases/import';
import { withArchiveGuard } from '@/lib/usecases/archive-guard';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { ImportHistoryScreen } from './import-history-screen';

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
}));

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
const h = en.history;

// ── synthetic exports (generated here, never read from disk) ───────────────────────────────────
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const BASE = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:00:00] Bo: Hola',
];
const NEWER = [...BASE, '[19/03/2026, 10:00:00] Ana: Nou'];
const photo = new Uint8Array(200).map((_, i) => (i * 3) % 251);
const zipOf = (lines: string[]) => new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), [PHOTO]: photo }) as BlobPart]);
const NAME = 'WhatsApp Chat - Ana i Bo.zip';

/** Imports with their own, increasing instant each, so the order is certain. */
function importer(lib: Lib) {
  let tick = 0;
  const deps = { ...lib.deps, now: () => new Date(Date.UTC(2026, 2, 1, 10, 0, ++tick)) };
  return async (fileName: string, lines: string[], profileIds: string[], meAuthor: string | null = 'Ana') => {
    const r = await importWhatsAppExport(deps, { zip: zipOf(lines), fileName, profileIds, meAuthor });
    if (r.status !== 'imported') throw new Error(r.status);
    return r;
  };
}

/** Cheap batches straight into the database: batch i has instant i, the first one creates the conversation. */
function seedBatches(lib: Lib, count: number) {
  for (let i = 0; i < count; i++) {
    importMessages(lib.opened.db, {
      batchId: `00000000-0000-4000-8000-${(0x100 + i).toString(16).padStart(12, '0')}`,
      conversationId: '00000000-0000-4000-8000-0000000000c1',
      source: 'whatsapp',
      sourceLabel: `f${i}.zip`,
      now: `2026-03-01T10:00:${String(i).padStart(2, '0')}Z`,
      blobs: [],
      meAuthor: null,
      ...(i === 0 ? { newConversation: { title: 'Seeded', sourceKey: 'k', isGroup: false, profileIds: [] } } : {}),
      messages: [
        { fingerprint: (i + 1).toString(16).padStart(64, '0'), sentAt: '2026-03-01T10:00:00', ordinal: i, type: 'text' as const, participantName: 'Ana', body: `m${i}`, mediaSha256: null, mediaName: '' },
      ],
    });
  }
}

async function open(prepare?: (lib: Lib) => Promise<void>, query = '', messages?: Record<string, unknown>, existing?: Lib, paging?: { page?: number; cap?: number }) {
  const lib = existing ?? (await createTestLibrary());
  await prepare?.(lib);
  search = query;
  const view = await renderWithLibrary(<ImportHistoryScreen paging={paging} />, { lib, messages });
  await settle();
  return view;
}

const text = (view: Rendered) => view.container.textContent ?? '';
const entries = (view: Rendered) => [...view.container.querySelectorAll<HTMLLIElement>('ul[aria-label] > li')];
const buttonNamed = (view: Rendered, name: string | RegExp) =>
  [...view.container.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''))) ?? null;
const undoButton = (view: Rendered, title: string) => view.container.querySelector<HTMLButtonElement>(`button[aria-label="${en.import.result.undoLabel.replace('{title}', title)}"]`);
const announced = (view: Rendered) => view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent;

async function pressEscape(el: Element) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

describe('the import history screen', () => {
  let view: Rendered | undefined;
  beforeEach(() => {
    search = '';
  });
  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  test('an empty archive says so calmly and offers to import a chat', async () => {
    view = await open();
    expect(view.container.querySelector('h1')?.textContent).toBe(h.title);
    expect(view.container.querySelector('h2')?.textContent).toBe(h.emptyTitle);
    expect(view.container.querySelector('a[href="/import"]')?.textContent).toBe(h.import);
    expect(view.container.querySelector('a[href="/people"]')?.textContent).toBe(h.back);
    expect(entries(view)).toHaveLength(0);
  });

  test('lists the imports newest first with what each one added, where it is kept and when', async () => {
    let ana = '';
    view = await open(async (lib) => {
      const run = importer(lib);
      ana = (await createProfile(lib.deps, { displayName: 'Ana' })).id;
      await run(NAME, BASE, [ana]);
      await run(NAME, NEWER, [ana]);
    });
    const [newer, first] = entries(view);
    expect(newer.querySelector('h2')?.textContent).toBe('Ana i Bo');
    expect(newer.textContent).toContain(NAME);
    expect(newer.textContent).toContain('1 new message added.');
    expect(newer.textContent).toContain('4 messages were already in the archive.');
    expect(newer.textContent).not.toContain(h.createdConversation);
    expect(newer.querySelector('time')?.getAttribute('dateTime')).toBe('2026-03-01T10:00:02.000Z');

    expect(first.textContent).toContain(NAME);
    expect(first.textContent).toContain('4 new messages added.');
    expect(first.textContent).toContain(h.createdConversation);
    expect(first.textContent).toContain('1 message still has its photo or file.');
    expect(first.textContent).not.toContain('already in the archive');
    expect(first.querySelector(`a[href="/person?id=${ana}"]`)?.textContent).toBe('Ana');
  });

  test('an import for no one yet says it is not assigned', async () => {
    view = await open(async (lib) => {
      await importer(lib)(NAME, BASE, []);
    });
    expect(text(view)).toContain(h.unassigned);
    expect(view.container.querySelector('a[href^="/person?id="]')).toBeNull();
  });

  test('a re-import that added nothing is not listed', async () => {
    view = await open(async (lib) => {
      const run = importer(lib);
      await run(NAME, BASE, []);
      await run(NAME, BASE, []);
    });
    expect(entries(view)).toHaveLength(1);
  });

  test('shows a page at a time, then older ones with "Show older imports" and moves the focus to the first new one', async () => {
    view = await open(async (lib) => {
      const run = importer(lib);
      const ana = await createProfile(lib.deps, { displayName: 'Ana' });
      for (let i = 0; i < 22; i++) {
        await run(`Export ${i}.zip`, [`[1${i % 10}/03/2026, 10:0${i % 10}:00] Ana: m${i}`, `[2${i % 10}/03/2026, 10:0${i % 10}:00] Bo: n${i}`], [ana.id], null);
      }
    });
    expect(entries(view)).toHaveLength(20);
    expect(entries(view)[0].textContent).toContain('Export 21.zip');
    await click(buttonNamed(view, h.loadMore));
    await settle();
    expect(entries(view)).toHaveLength(22);
    expect(entries(view)[21].textContent).toContain('Export 0.zip');
    expect(buttonNamed(view, h.loadMore)).toBeNull();
    // The first of the new entries has the focus (moved after the DOM settles): wait for it
    // instead of sleeping, a slow runner needs more than a fixed few milliseconds.
    const shown = view;
    await vi.waitFor(() => expect(document.activeElement).toBe(entries(shown)[20].querySelector('h2')), { timeout: 3000 });
  });

  test('a person filter shows only their imports, says whose, and can show all again', async () => {
    let bo = '';
    const lib = await createTestLibrary();
    view = await open(async () => {
      const run = importer(lib);
      const ana = await createProfile(lib.deps, { displayName: 'Ana' });
      bo = (await createProfile(lib.deps, { displayName: 'Bo' })).id;
      await run('Ana file.zip', BASE, [ana.id]);
      await run('Bo file.zip', ['[17/03/2026, 13:17:05] Cy: hi', '[17/03/2026, 13:18:05] Di: yo'], [bo], null);
    }, '', undefined, lib);
    expect(entries(view)).toHaveLength(2);
    view.unmount();
    view = await open(undefined, `person=${bo}`, undefined, lib);
    expect(entries(view)).toHaveLength(1);
    expect(entries(view)[0].textContent).toContain('Bo file.zip');
    expect(text(view)).toContain('Imports into the conversations kept under Bo.');
    expect(view.container.querySelector('a[href="/import/history"]')?.textContent).toBe(h.showAll);
    expect(view.container.querySelector(`a[href="/person?id=${bo}"]`)?.textContent).toContain('Back to Bo');
  });

  test('a person with no imports gets a calm empty state; an unknown person gets "not found"', async () => {
    const lib = await createTestLibrary();
    const cy = (await createProfile(lib.deps, { displayName: 'Cy' })).id;
    view = await open(undefined, `person=${cy}`, undefined, lib);
    expect(view.container.querySelector('h2')?.textContent).toBe('Nothing has been imported for Cy yet');
    view.unmount();
    view = await open(undefined, 'person=not-an-id', undefined, lib);
    expect(view.container.querySelector('h1')?.textContent).toBe(en.person.notFoundTitle);
  });

  describe('paging', () => {
    const confirmUndoOfFirst = async (v: Rendered) => {
      await click(entries(v)[0].querySelector('button'));
      await click(buttonNamed(v, en.import.undo.confirm));
      await settle();
    };

    test('after an undo the list keeps every entry it had loaded, beyond the server cap, and can still load older ones', async () => {
      const lib = await createTestLibrary();
      seedBatches(lib, 9);
      view = await open(undefined, '', undefined, lib, { page: 2, cap: 3 });
      expect(entries(view)).toHaveLength(2);
      await click(buttonNamed(view, h.loadMore));
      await settle();
      await click(buttonNamed(view, h.loadMore));
      await settle();
      expect(entries(view)).toHaveLength(6);

      await confirmUndoOfFirst(view);
      // Six were loaded (more than the cap of 3), so six are still shown: the newest one is gone, the one after the old last is in.
      expect(entries(view)).toHaveLength(6);
      expect(entries(view)[0].textContent).toContain('f7.zip');
      expect(entries(view)[5].textContent).toContain('f2.zip');
      expect(buttonNamed(view, h.loadMore)).not.toBeNull();
      await click(buttonNamed(view, h.loadMore));
      await settle();
      expect(entries(view)).toHaveLength(8);
    });

    test('a page dropped because the list changed meanwhile is not shown as a read failure', async () => {
      const lib = await createTestLibrary();
      seedBatches(lib, 5);
      const real = lib.client.call.bind(lib.client);
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(lib.client, 'call').mockImplementation(((op: string, params: { before?: unknown }) =>
        op === 'listImportBatches' && params.before ? held.then(() => real(op as never, params as never)) : real(op as never, params as never)) as never);
      view = await open(undefined, '', undefined, lib, { page: 2 });
      await click(buttonNamed(view, h.loadMore));
      // While the older page is on its way, an undo reloads the list.
      await click(entries(view)[0].querySelector('button'));
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      release();
      await settle();
      expect(text(view)).not.toContain(h.loadMoreFailed);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(buttonNamed(view, h.loadMore)?.getAttribute('aria-disabled')).toBeNull();
      vi.restoreAllMocks();
    });

    test('an older page that could not be read says so, and can be tried again', async () => {
      const lib = await createTestLibrary();
      seedBatches(lib, 5);
      const real = lib.client.call.bind(lib.client);
      const spy = vi.spyOn(lib.client, 'call').mockImplementation(((op: string, params: { before?: unknown }) =>
        op === 'listImportBatches' && params.before ? Promise.reject(new DbError('invalid', 'SQLITE_ERROR: secret detail')) : real(op as never, params as never)) as never);
      view = await open(undefined, '', undefined, lib, { page: 2 });
      await click(buttonNamed(view, h.loadMore));
      await settle();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(h.loadMoreFailed);
      expect(text(view)).not.toContain('secret detail');
      spy.mockRestore();
      await click(buttonNamed(view, h.loadMore));
      await settle();
      expect(entries(view)).toHaveLength(4);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });

    test('when the last page turns out to be empty the focus goes to the heading, not to the page', async () => {
      const lib = await createTestLibrary();
      seedBatches(lib, 2);
      view = await open(undefined, '', undefined, lib, { page: 2 });
      expect(entries(view)).toHaveLength(2);
      const more = buttonNamed(view, h.loadMore)!;
      more.focus();
      await click(more);
      await settle();
      expect(buttonNamed(view, h.loadMore)).toBeNull();
      const shown = view;
      await vi.waitFor(() => expect(document.activeElement).toBe(shown.container.querySelector('h1')), { timeout: 3000 });
    });
  });

  describe('undo', () => {
    const seedOne = async (lib: Lib) => {
      const ana = await createProfile(lib.deps, { displayName: 'Ana' });
      const run = importer(lib);
      await run(NAME, BASE, [ana.id]);
    };

    test('asks first, says what goes and what stays, and Escape or "Keep it" changes nothing and returns the focus', async () => {
      view = await open(seedOne);
      const ask = undoButton(view, 'Ana i Bo')!;
      expect(ask).not.toBeNull();
      await click(ask);
      const panel = view.container.querySelector('[role="group"]')!;
      expect(panel.textContent).toContain(en.import.undo.title);
      expect(panel.textContent).toContain('The 4 messages this import added will be removed');
      expect(panel.textContent).toContain('“Ana i Bo”, so that conversation is removed too if nothing else is left in it');
      expect(panel.textContent).toContain('the notes and favorites on it go with it');
      expect(panel.textContent).toContain('Messages from other imports, and anything that was in your archive before, stay.');
      expect(document.activeElement).toBe(buttonNamed(view, en.import.undo.cancel));

      await pressEscape(buttonNamed(view, en.import.undo.cancel)!);
      expect(view.container.querySelector('[role="group"]')).toBeNull();
      expect(document.activeElement).toBe(undoButton(view, 'Ana i Bo'));
      expect(entries(view)).toHaveLength(1);

      await click(undoButton(view, 'Ana i Bo'));
      await click(buttonNamed(view, en.import.undo.cancel));
      expect(view.container.querySelector('[role="group"]')).toBeNull();
      expect(entries(view)).toHaveLength(1);
    });

    test('Escape while an input method is composing does not close it', async () => {
      view = await open(seedOne);
      await click(undoButton(view, 'Ana i Bo'));
      const cancel = buttonNamed(view, en.import.undo.cancel)!;
      await act(async () => {
        cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }));
      });
      expect(view.container.querySelector('[role="group"]')).not.toBeNull();
    });

    test('confirming removes the import, announces the result and puts the focus on the page heading', async () => {
      const lib = await createTestLibrary();
      view = await open(seedOne, '', undefined, lib);
      await click(undoButton(view, 'Ana i Bo'));
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      expect(entries(view)).toHaveLength(0);
      expect(view.container.querySelector('h2')?.textContent).toBe(h.emptyTitle);
      expect(announced(view)).toBe('The import was undone. 4 messages were removed.');
      expect(document.activeElement).toBe(view.container.querySelector('h1'));
      // The conversation this import created is gone with it.
      expect(await lib.client.call('listConversations', {})).toEqual([]);
    });

    test('undoing one import leaves the other imports and their messages alone', async () => {
      const lib = await createTestLibrary();
      let newerId = '';
      view = await open(async () => {
        const ana = await createProfile(lib.deps, { displayName: 'Ana' });
        const run = importer(lib);
        await run(NAME, BASE, [ana.id]);
        newerId = (await run(NAME, NEWER, [ana.id])).batchId;
      }, '', undefined, lib);
      const [newer] = entries(view);
      await click(newer.querySelector('button'));
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      expect(entries(view)).toHaveLength(1);
      expect(entries(view)[0].textContent).toContain(NAME);
      expect(entries(view)[0].textContent).toContain('4 new messages added.');
      expect(announced(view)).toBe('The import was undone. 1 message was removed.');
      expect(newerId).not.toBe('');
    });

    test('while another task uses the archive it says so calmly, changes nothing, and works when tried again', async () => {
      const lib = await createTestLibrary();
      view = await open(seedOne, '', undefined, lib);
      await click(undoButton(view, 'Ana i Bo'));

      let release: () => void = () => {};
      const holding = withArchiveGuard(lib.deps.blobStore, () => new Promise<void>((resolve) => (release = resolve)));
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      const alert = view.container.querySelector('[role="group"] [role="alert"]')!;
      expect(alert.textContent).toBe(en.import.problem.busy);
      expect(alert.textContent).not.toMatch(/archive operation|ArchiveError/);
      expect(entries(view)).toHaveLength(1);
      expect(buttonNamed(view, en.import.undo.confirm)?.getAttribute('aria-disabled')).toBeNull();

      release();
      await holding;
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      expect(entries(view)).toHaveLength(0);
    });

    test('any other failure says nothing was changed, in plain words', async () => {
      const lib = await createTestLibrary();
      view = await open(seedOne, '', undefined, lib);
      await click(undoButton(view, 'Ana i Bo'));
      const real = lib.client.call.bind(lib.client);
      const spy = vi.spyOn(lib.client, 'call').mockImplementation(((op: string, params: unknown) =>
        op === 'undoImportBatch' ? Promise.reject(new DbError('invalid', 'SQLITE_ERROR: secret detail')) : real(op as never, params as never)) as never);
      await click(buttonNamed(view, en.import.undo.confirm));
      await settle();
      expect(view.container.querySelector('[role="group"] [role="alert"]')?.textContent).toBe(en.import.undo.failed);
      expect(text(view)).not.toContain('secret detail');
      spy.mockRestore();
    });

    test('an import whose messages are all gone has no undo and explains why', async () => {
      let batch = '';
      const lib = await createTestLibrary();
      view = await open(async () => {
        batch = (await importer(lib)(NAME, BASE, [])).batchId;
        lib.opened.db.run('DELETE FROM messages WHERE batch_id = ?', [batch]);
      }, '', undefined, lib);
      expect(entries(view)).toHaveLength(1);
      expect(undoButton(view, 'Ana i Bo')).toBeNull();
      expect(text(view)).toContain(h.nothingLeft);
    });
  });

  test('an import that added no messages says there is nothing to undo, without blaming missing messages', async () => {
    const lib = await createTestLibrary();
    view = await open(async () => {
      const r = await importer(lib)(NAME, BASE, []);
      lib.opened.db.run('DELETE FROM messages WHERE batch_id = ?', [r.batchId]);
      lib.opened.db.run('UPDATE import_batches SET added_count = 0 WHERE id = ?', [r.batchId]);
    }, '', undefined, lib);
    expect(entries(view)).toHaveLength(1);
    expect(text(view)).toContain(h.nothingAdded);
    expect(text(view)).not.toContain(h.nothingLeft);
    expect(entries(view)[0].querySelector('button')).toBeNull();
  });

  test('says the history could not be read, without technical detail, and keeps nothing hidden', async () => {
    const lib = await createTestLibrary();
    const real = lib.client.call.bind(lib.client);
    vi.spyOn(lib.client, 'call').mockImplementation(((op: string, params: unknown) =>
      op === 'listImportBatches' ? Promise.reject(new DbError('invalid', 'SQLITE_ERROR: secret detail')) : real(op as never, params as never)) as never);
    view = await open(undefined, '', undefined, lib);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(h.loadFailed);
    expect(text(view)).not.toContain('secret detail');
    vi.restoreAllMocks();
  });

  test('long file and conversation names wrap instead of widening the page', async () => {
    const long = `${'x'.repeat(120)}.zip`;
    view = await open(async (lib) => {
      await importer(lib)(long, BASE, []);
    });
    const li = entries(view)[0];
    expect(li.querySelector('h2')?.className).toContain('break-words');
    expect([...li.querySelectorAll('p')].find((p) => p.textContent === long)?.className).toContain('break-words');
  });

  test('speaks Catalan with correct plurals', async () => {
    view = await open(
      async (lib) => {
        await importer(lib)(NAME, BASE, []);
      },
      '',
      ca,
    );
    expect(view.container.querySelector('h1')?.textContent).toBe(ca.history.title);
    expect(entries(view)[0].textContent).toContain('S’han afegit 4 missatges nous.');
  });
});
