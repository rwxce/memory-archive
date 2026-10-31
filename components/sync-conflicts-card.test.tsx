import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { importMessages, renameConversation, setNote, undoImportBatch, updateProfile } from '@/lib/db/queries';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { listSyncConflicts } from '@/lib/usecases/sync-conflicts';
import { ANA, B2, B3, C1, C2, NOW, idOf, msg, populated, putMedia, send, type Lib } from '@/lib/usecases/test-sync';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { SyncScreen } from './sync-screen';

vi.mock('@/hooks/download-blob', () => ({ downloadBlob: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sync',
}));

const c = en.sync.conflicts;
const text = (v: Rendered) => v.container.textContent ?? '';
const card = (v: Rendered) => v.container.querySelector<HTMLElement>('#sync-conflicts')!;
const button = (v: Rendered, name: string) => [...card(v).querySelectorAll('button')].find((el) => el.textContent?.trim() === name);
const radio = (v: Rendered, startsWith: string) =>
  [...card(v).querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((el) => el.closest('label')?.textContent?.startsWith(startsWith));
const items = (v: Rendered) => card(v).querySelectorAll('[data-testid="sync-conflict"]');
const status = (v: Rendered) => card(v).querySelector('[role="status"]')?.textContent ?? '';

let views: Rendered[] = [];
afterEach(() => {
  for (const view of views) view.unmount();
  views = [];
});
async function open(lib: Lib): Promise<Rendered> {
  const view = await renderWithLibrary(<SyncScreen />, { lib });
  views.push(view);
  await settle();
  return view;
}

/** Two devices in step, then the same person edited on both; `b` holds the conflict. */
async function crossed(edits: { a: string; b: string } = { a: 'from a', b: 'from b' }) {
  const a = await populated();
  const b = await createTestLibrary();
  await send(a, b);
  updateProfile(a.opened.db, { id: ANA, description: edits.a, now: NOW });
  updateProfile(b.opened.db, { id: ANA, description: edits.b, now: NOW });
  await send(a, b);
  return { a, b };
}
const description = (lib: Lib) => lib.opened.db.all<{ description: string }>('SELECT description FROM profiles WHERE id = ?', [ANA])[0].description;
async function choose(v: Rendered, option: string) {
  await click(radio(v, option));
  await click(button(v, c.apply));
  await settle();
}

describe('SyncConflictsCard', () => {
  test('is calm when there is nothing to review', async () => {
    const view = await open(await populated());
    expect(card(view).querySelector('h2')?.textContent).toBe(c.title);
    expect(text(view)).toContain(c.empty);
    expect(items(view)).toHaveLength(0);
  });

  test('shows both versions side by side with the other device\'s code, and no choice is preselected', async () => {
    const { a, b } = await crossed();
    const view = await open(b);
    expect(items(view)).toHaveLength(1);
    const body = card(view).textContent!;
    expect(body).toContain('from a');
    expect(body).toContain('from b');
    expect(body).toContain(c.thisDevice);
    expect(body).toContain(`Device ${(await idOf(a)).slice(0, 8)}`);
    expect(body).toContain('1 item to review');
    expect([...card(view).querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.checked)).toBe(false);
    // Apply waits for a choice and says why; clicking it does nothing.
    const apply = button(view, c.apply)!;
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(body).toContain(c.choose);
    await click(apply);
    expect(items(view)).toHaveLength(1);
    expect(radio(view, c.choice.both)).toBeUndefined();
  });

  test('keeping this device\'s version closes it, says so once, and moves focus to the card heading', async () => {
    const { b } = await crossed();
    const view = await open(b);
    await choose(view, c.choice.mine);
    expect(description(b)).toBe('from b');
    expect(await listSyncConflicts(b.deps)).toEqual([]);
    expect(items(view)).toHaveLength(0);
    expect(text(view)).toContain(c.empty);
    expect(status(view)).toBe(c.outcome.mine);
    expect(document.activeElement?.id).toBe('sync-conflicts-title');
  });

  test('taking the other device\'s version applies it', async () => {
    const { b } = await crossed();
    const view = await open(b);
    await choose(view, c.choice.theirs);
    expect(description(b)).toBe('from a');
    expect(status(view)).toBe(c.outcome.theirs);
  });

  test('a note can keep both texts; a profile cannot', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    const target = { kind: 'conversation', conversationId: C1 } as const;
    setNote(a.opened.db, { target, body: 'note on a', now: NOW });
    setNote(b.opened.db, { target, body: 'note on b', now: NOW });
    await send(a, b);
    const view = await open(b);
    expect(radio(view, c.choice.both)).toBeDefined();
    await choose(view, c.choice.both);
    const body = b.opened.db.all<{ body: string }>("SELECT body FROM notes WHERE kind = 'conversation' AND conversation_id = ?", [C1])[0]?.body ?? '';
    expect(body).toContain('note on a');
    expect(body).toContain('note on b');
    expect(status(view)).toBe(c.outcome.both);
  });

  test('focus goes to the next item after one is settled', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    for (const lib of [a, b]) {
      updateProfile(lib.opened.db, { id: ANA, description: `ana ${lib === a}`, now: NOW });
      renameConversation(lib.opened.db, { conversationId: C1, title: `title ${lib === a}` });
    }
    await send(a, b);
    const view = await open(b);
    expect(items(view)).toHaveLength(2);
    const second = items(view)[1].querySelector('h3')!.id;
    await click(items(view)[0].querySelector<HTMLInputElement>('input[type="radio"]'));
    await click(items(view)[0].querySelector('button'));
    await settle();
    expect(items(view)).toHaveLength(1);
    expect(document.activeElement?.id).toBe(second);
  });

  test('a double click settles it once', async () => {
    const { b } = await crossed();
    const view = await open(b);
    const call = vi.spyOn(b.client, 'call');
    await click(radio(view, c.choice.theirs));
    const apply = button(view, c.apply)!;
    await act(async () => {
      apply.click();
      apply.click();
    });
    await settle();
    expect(call.mock.calls.filter(([op]) => op === 'resolveSyncConflict')).toHaveLength(1);
    expect(items(view)).toHaveLength(0);
  });

  test('a record removed here meanwhile says nothing was applied', async () => {
    const { b } = await crossed();
    const view = await open(b);
    // The data layer decides that (tested there); this is how the screen words it.
    const real = b.client.call.bind(b.client);
    vi.spyOn(b.client, 'call').mockImplementation(((op: string, params: never) =>
      op === 'resolveSyncConflict' ? Promise.resolve({ unreferencedBlobs: [], recordGone: true }) : real(op as never, params)) as never);
    await choose(view, c.choice.theirs);
    expect(status(view)).toBe(c.outcome.recordGone);
  });

  test('an attempt that fails leaves the item in place and says nothing changed', async () => {
    const { b } = await crossed();
    const view = await open(b);
    const real = b.client.call.bind(b.client);
    vi.spyOn(b.client, 'call').mockImplementation(((op: string, params: never) =>
      op === 'resolveSyncConflict' ? Promise.reject(new Error('boom')) : real(op as never, params)) as never);
    await choose(view, c.choice.mine);
    expect(status(view)).toBe(c.outcome.failed);
    expect(items(view)).toHaveLength(1);
  });

  test('text from the other device is shown as text, never as markup', async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const { b } = await crossed({ a: evil, b: 'plain' });
    const view = await open(b);
    expect(card(view).textContent).toContain(evil);
    expect(card(view).querySelector('img')).toBeNull();
  });

  test('long text is shown in full, so nobody chooses blind', async () => {
    const { b } = await crossed({ a: 'x'.repeat(600), b: 'short' });
    const view = await open(b);
    expect(card(view).textContent).toContain('x'.repeat(600));
    expect(card(view).querySelector('.line-clamp-5')).toBeNull();
    expect(card(view).querySelector('[aria-expanded]')).toBeNull();
  });

  test('a choice made on a conflict that was replaced is refused, the item resets, and nothing changes', async () => {
    const { b } = await crossed();
    const view = await open(b);
    await click(radio(view, c.choice.theirs));
    expect(radio(view, c.choice.theirs)!.checked).toBe(true);
    // A newer version of the same record replaced the row while the person was reading.
    b.opened.db.run("UPDATE sync_conflicts SET detected_at = '2099-01-01T00:00:00.000Z'");
    await click(button(view, c.apply));
    await settle();
    expect(status(view)).toBe(c.outcome.settled);
    expect(description(b)).toBe('from b');
    expect(items(view)).toHaveLength(1);
    expect(radio(view, c.choice.theirs)!.checked).toBe(false);
    expect(button(view, c.apply)!.getAttribute('aria-disabled')).toBe('true');
  });

  test('the same outcome twice is announced twice, and the choices are described by the item heading', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    await send(a, b);
    for (const lib of [a, b]) {
      updateProfile(lib.opened.db, { id: ANA, description: `ana ${lib === a}`, now: NOW });
      renameConversation(lib.opened.db, { conversationId: C1, title: `title ${lib === a}` });
    }
    await send(a, b);
    const view = await open(b);
    const fieldset = items(view)[0].querySelector('fieldset')!;
    expect(fieldset.getAttribute('aria-describedby')).toBe(items(view)[0].querySelector('h3')!.id);
    await choose(view, c.choice.mine);
    const first = card(view).querySelector('[role="status"] span');
    expect(first?.textContent).toBe(c.outcome.mine);
    await new Promise((r) => setTimeout(r, 1100));
    await choose(view, c.choice.mine);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    const second = card(view).querySelector('[role="status"] span');
    expect(second?.textContent).toBe(c.outcome.mine);
    expect(second).not.toBe(first);
  });

  test('a note is named by its conversation, and keeping both for a note deleted here meanwhile says so plainly', async () => {
    const a = await populated();
    const b = await createTestLibrary();
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'first', now: NOW });
    await send(a, b);
    setNote(a.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'note on a', now: NOW });
    setNote(b.opened.db, { target: { kind: 'conversation', conversationId: C1 }, body: 'note on b', now: NOW });
    await send(a, b);
    const view = await open(b);
    expect(items(view)[0].querySelector('h3')!.textContent).toBe('Note: Ana & me');
    b.opened.db.run('DELETE FROM notes WHERE conversation_id = ?', [C1]);
    await choose(view, c.choice.both);
    expect(status(view)).toBe(c.outcome.bothRestored);
  });
});

describe('SyncConflictsCard: an import undone on the other device', () => {
  async function offered() {
    const x = await populated();
    const y = await createTestLibrary();
    const m = await putMedia(x, 21);
    importMessages(x.opened.db, { batchId: B3, conversationId: C1, source: 'whatsapp', sourceLabel: 'extra.zip', now: NOW, blobs: [m], messages: [msg(5, 'Ana', 'extra', m.sha256)] });
    await send(x, y);
    undoImportBatch(x.opened.db, B3);
    return { x, y };
  }

  test('undoing it here asks first, naming the conversation and the number of messages, then removes them', async () => {
    const { x, y } = await offered();
    await send(x, y);
    const view = await open(y);
    expect(card(view).textContent).toContain('Ana & me');
    expect(card(view).textContent).toContain('1 message from it is still here.');
    await click(button(view, en.sync.conflicts.batch.undo));
    const ask = card(view).querySelector('[role="group"]')!;
    expect(ask.textContent).toContain('The 1 message added by that import will be removed from “Ana & me”');
    expect(ask.textContent).toContain('no other conversation uses');
    expect(document.activeElement?.textContent).toBe(c.batch.cancel);
    expect(y.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toHaveLength(1);
    await click(button(view, c.batch.confirm));
    await settle();
    expect(y.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toHaveLength(0);
    expect(status(view)).toBe(c.outcome.undone);
    expect(items(view)).toHaveLength(0);
  });

  test('going back from the question changes nothing, and Keep it dismisses the offer', async () => {
    const { x, y } = await offered();
    await send(x, y);
    const view = await open(y);
    await click(button(view, c.batch.undo));
    await click(button(view, c.batch.cancel));
    expect(items(view)).toHaveLength(1);
    expect(document.activeElement?.textContent).toContain(c.batch.undo);
    await click(button(view, c.batch.keep));
    await settle();
    expect(y.opened.db.all('SELECT 1 FROM messages WHERE batch_id = ?', [B3])).toHaveLength(1);
    expect(status(view)).toBe(c.outcome.dismissed);
    expect(items(view)).toHaveLength(0);
  });

  test('an import this device never had is a calm note that can be closed', async () => {
    const { x } = await offered();
    const z = await createTestLibrary();
    await send(x, z);
    const view = await open(z);
    expect(card(view).textContent).toContain(c.batch.unmatched);
    expect(button(view, c.batch.undo)).toBeUndefined();
    await click(button(view, c.batch.close));
    await settle();
    expect(items(view)).toHaveLength(0);
    expect(status(view)).toBe(c.outcome.dismissed);
  });

  test('the question promises the conversation goes only when nothing else is in it', async () => {
    const x = await populated();
    const y = await createTestLibrary();
    await send(x, y);
    undoImportBatch(x.opened.db, B2);
    await send(x, y);
    const only = await open(y);
    await click(button(only, c.batch.undo));
    expect(card(only).querySelector('[role="group"]')!.textContent).toContain('and so will the conversation');

    const x2 = await populated();
    const y2 = await createTestLibrary();
    await send(x2, y2);
    importMessages(y2.opened.db, { batchId: B3, conversationId: C2, source: 'whatsapp', sourceLabel: 'later.zip', now: NOW, blobs: [], messages: [msg(9, 'Ben', 'later')] });
    undoImportBatch(x2.opened.db, B2);
    await send(x2, y2);
    const shared = await open(y2);
    await click(button(shared, c.batch.undo));
    const ask = card(shared).querySelector('[role="group"]')!.textContent!;
    expect(ask).not.toContain('and so will the conversation');
    expect(ask).toContain('If nothing else is left in that conversation');
  });
});
