import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { MAX_FINDINGS_TEXT } from '@/lib/domain/highlights';
import { unlinkConversationFromProfile } from '@/lib/usecases/conversations';
import { countHighlights } from '@/lib/usecases/highlights';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from '@/hooks/use-library';
import { CHAT, findingsOf, hl } from './highlights-fixture';
import { HighlightsImport } from './highlights-import';
import { load, msg, seedNotes, uuid, type Lib } from './notes-fixture';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';

const t = en.highlightsImport;
let view: (Rendered & { lib: Lib }) | undefined;
let imported = vi.fn();

function Harness({ personId }: { personId: string }) {
  const { state } = useLibrary();
  return state.status === 'ready' ? <HighlightsImport personId={personId} onImported={imported} /> : null;
}

async function open(prepare?: (lib: Lib, personId: string) => Promise<void>) {
  const lib = await createTestLibrary();
  const { ana } = await seedNotes(lib);
  await prepare?.(lib, ana.id);
  view = await renderWithLibrary(<Harness personId={ana.id} />, { lib });
  await settle();
  return lib;
}

const text = () => view!.container.textContent ?? '';
const button = (label: string) => [...view!.container.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function choose(content: string, name = 'findings.json', size?: number) {
  const input = view!.container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: 'application/json' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const good = (name = 'Chat') => JSON.stringify(findingsOf([hl('a', 'moment', [1]), hl('b', 'pattern', [2, 3])], name));

beforeEach(() => {
  imported = vi.fn();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('HighlightsImport', () => {
  test('explains itself and that re-importing is safe, in plain words', async () => {
    await open();
    expect(text()).toContain(t.description);
    expect(text()).toContain(t.safeNote);
    expect(button(t.choose)).toBeTruthy();
  });

  test('checks the file, preselects the conversation named like the file, imports and reports, and reports', async () => {
    const lib = await open();
    await choose(good());
    expect(text()).toContain('2 highlights for “Chat”.');
    // Two conversations; the one named like the file is preselected.
    expect(view!.container.querySelector('select')!.value).toBe(CHAT);
    await click(button(t.confirm));
    await settle();
    expect(text()).toContain(t.doneTitle);
    expect(text()).toContain('2 highlights added');
    expect(text()).toContain('0 highlights updated');
    expect(imported).toHaveBeenCalledOnce();
    expect(await countHighlights(lib.deps)).toBe(2);
    expect(text()).not.toContain(t.warningsTitle);

    // The same file again changes nothing.
    await click(button(t.importAnother));
    await choose(good());
    await click(button(t.confirm));
    await settle();
    expect(text()).toContain('2 highlights were already there');
    expect(text()).toContain('0 highlights added');
    expect(await countHighlights(lib.deps)).toBe(2);
  });

  test('with several conversations the person chooses one before importing', async () => {
    await open(async (lib, personId) => {
      await load(lib, uuid(0x40), 'Other', personId, [msg()]);
    });
    await choose(good('Something else'));
    const select = view!.container.querySelector('select')!;
    expect(view!.container.querySelector(`label[for="${select.id}"]`)!.textContent).toBe(t.target);
    expect(button(t.confirm).disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, CHAT);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button(t.confirm).disabled).toBe(false);
    await click(button(t.confirm));
    await settle();
    expect(text()).toContain('2 highlights added');
  });

  test('lists what is wrong with a file by path and fixed message, never its content', async () => {
    const lib = await open();
    const secret = 'PRIVATE-CHAT-TEXT';
    await choose(JSON.stringify({ version: 1, conversation: { name: 'Chat', messageCount: 4 }, highlights: [{ id: 'a', category: 'nope', title: secret, summary: '', messages: ['zz'], createdBy: 'x', createdAt: 'later' }] }));
    const alert = view!.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(t.invalid);
    expect(alert.textContent).toContain('highlights[0].category');
    expect(alert.textContent).toContain('Must be one of');
    expect(text()).not.toContain(secret);
    expect(button(t.confirm)).toBeUndefined();
    expect(await countHighlights(lib.deps)).toBe(0);
    await choose('not json');
    expect(view!.container.querySelector('[role="alert"]')!.textContent).toContain('The file is not valid JSON.');
  });

  test('refuses a file over the limit before reading it', async () => {
    await open();
    const text_ = vi.spyOn(File.prototype, 'text');
    await choose('{}', 'big.json', MAX_FINDINGS_TEXT + 1);
    expect(view!.container.querySelector('[role="alert"]')!.textContent).toContain(t.tooLarge);
    expect(text_).not.toHaveBeenCalled();
    text_.mockRestore();
  });

  test('warns, without stopping, when the file does not match the conversation', async () => {
    await open();
    await choose(JSON.stringify(findingsOf([hl('a', 'moment', [1, 2]), hl('ghost', 'moment', [99]), hl('c', 'pattern', [1, 98])], 'Chat', 10)));
    await click(button(t.confirm));
    await settle();
    expect(text()).toContain(t.warning['message-count-differs']);
    expect(text()).toContain('1 highlight was left out');
    expect(text()).toContain('2 message references');
  });

  test('with a single conversation there is no selector and it is the target', async () => {
    await open(async (lib, personId) => {
      await unlinkConversationFromProfile(lib.deps, uuid(0x21), personId);
    });
    await choose(good('Anything'));
    expect(view!.container.querySelector('select')).toBeNull();
    expect(text()).toContain('Import into “Chat”.');
    await click(button(t.confirm));
    await settle();
    expect(text()).toContain('2 highlights added');
  });

  test('says there is nowhere to import when the person has no conversations', async () => {
    const lib = await createTestLibrary();
    const { createProfile } = await import('@/lib/usecases/profiles');
    const person = await createProfile(lib.deps, { displayName: 'Empty' });
    view = await renderWithLibrary(<Harness personId={person.id} />, { lib });
    await settle();
    expect(text()).toContain(t.noConversations);
    expect(view.container.querySelector('button')).toBeNull();
  });
});
