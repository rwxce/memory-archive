import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import { PROFILE_DESCRIPTION_MAX } from '@/lib/domain/profile';
import { phraseFromBody } from '@/hooks/use-phrase';
import { getPersonDetails } from '@/lib/usecases/library';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { ConversationScreen } from './conversation-screen';
import { CHAT, HOSTILE, seedNotes, type Lib } from './notes-fixture';
import { renderWithLibrary, settle, type Rendered } from './test-utils';

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

const p = en.phrase;
let view: (Rendered & { lib: Lib }) | undefined;
let seeded: Awaited<ReturnType<typeof seedNotes>>;

async function open(prepare?: (lib: Lib, ana: { id: string }) => Promise<void>) {
  const lib = await createTestLibrary();
  seeded = await seedNotes(lib);
  await prepare?.(lib, seeded.ana);
  search = `id=${CHAT}`;
  view = await renderWithLibrary(<ConversationScreen />, { lib });
  await settle();
  return lib;
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const articles = () => [...view!.container.querySelectorAll<HTMLElement>('article')];
const detailsOf = async (article: HTMLElement) => {
  await click(article.querySelector('button[aria-label="Details"], button[aria-expanded]:last-of-type')!);
  await settle();
};
const action = () => [...view!.container.querySelectorAll('button')].find((b) => b.textContent?.includes("phrase") && b.textContent.startsWith('Use as'));
const live = (role: string) => [...view!.container.querySelectorAll(`[role="${role}"]`)].map((e) => e.textContent).join('|');
const phraseOf = async (lib: Lib) => (await getPersonDetails(lib.deps, seeded.ana.id))!.person.description;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return this.getAttribute('role') === 'feed' ? 600 : 0; } });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  sessionStorage.clear();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('phraseFromBody', () => {
  test('trims, drops control characters and never splits a surrogate pair', () => {
    expect(phraseFromBody('  hi\u0007 there \n')).toBe('hi there');
    const cut = phraseFromBody('a' + '😀'.repeat(PROFILE_DESCRIPTION_MAX));
    expect(cut.length).toBeLessThanOrEqual(PROFILE_DESCRIPTION_MAX);
    expect([...cut].every((c) => c === 'a' || c === '😀')).toBe(true);
    expect(phraseFromBody('   ')).toBe('');
  });
});

describe('use as phrase, in a message\'s details', () => {
  test('is offered for a text message only, and sets the phrase as plain text when there is none', async () => {
    const lib = await open();
    const rows = articles().filter((a) => a.querySelector('button[aria-expanded]'));
    expect(rows.length).toBeGreaterThan(0);
    const hostile = rows.find((a) => a.textContent?.includes(HOSTILE))!;
    await detailsOf(hostile);
    const button = action()!;
    expect(button.textContent).toBe("Use as Ana M.'s phrase");
    await click(button);
    await settle();
    expect(await phraseOf(lib)).toBe(HOSTILE);
    expect(live('status')).toContain(p.saved.replace('{name}', 'Ana M.'));
    expect(view!.container.querySelector('img')).toBeNull();
  });

  test('is not offered on a message without text', async () => {
    await open(async (lib) => {
      await lib.client.call('importMessages', {
        batchId: '00000000-0000-4000-8000-0000000009aa',
        conversationId: '00000000-0000-4000-8000-000000000099',
        source: 'whatsapp',
        sourceLabel: 'y.zip',
        now: '2026-04-01T12:00:00Z',
        blobs: [],
        messages: [{ fingerprint: 'f'.repeat(64), sentAt: '2026-03-20T10:00:00', ordinal: 0, type: 'photo', participantName: 'Bo', body: '', mediaSha256: null, mediaName: 'x.jpg' }],
        newConversation: { title: 'Photos', sourceKey: 'p', isGroup: false, profileIds: [seeded.ana.id] },
      });
    });
    search = 'id=00000000-0000-4000-8000-000000000099';
    view!.unmount();
    view = await renderWithLibrary(<ConversationScreen />, { lib: view!.lib });
    await settle();
    const row = articles().find((a) => a.querySelector('button[aria-expanded]'))!;
    await detailsOf(row);
    expect(action()).toBeUndefined();
  });

  test('asks first when a phrase exists, shows it as text, and keeps it on cancel', async () => {
    const lib = await open(async (l, ana) => {
      await l.client.call('updateProfile', { id: ana.id, description: '<b>old</b>', now: '2026-04-02T00:00:00Z' });
    });
    const row = articles().find((a) => a.textContent?.includes(HOSTILE))!;
    await detailsOf(row);
    await click(action()!);
    const dialog = view!.container.querySelector('dialog')!;
    expect(dialog.textContent).toContain('<b>old</b>');
    expect(dialog.querySelector('b')).toBeNull();
    expect(await phraseOf(lib)).toBe('<b>old</b>');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === p.cancel)!);
    expect(view!.container.querySelector('dialog')).toBeNull();
    expect(await phraseOf(lib)).toBe('<b>old</b>');
    await click(action()!);
    await click([...view!.container.querySelectorAll('dialog button')].find((b) => b.textContent === p.confirm)!);
    await settle();
    expect(await phraseOf(lib)).toBe(HOSTILE);
    expect(view!.container.querySelector('dialog')).toBeNull();
  });

  test('says calmly that nothing changed when saving fails', async () => {
    const lib = await open();
    const row = articles().find((a) => a.textContent?.includes(HOSTILE))!;
    await detailsOf(row);
    const original = lib.client.call.bind(lib.client);
    vi.spyOn(lib.client, 'call').mockImplementation(((name: string, ...rest: unknown[]) =>
      name === 'updateProfile' ? Promise.reject(new Error('boom')) : (original as (...a: unknown[]) => unknown)(name, ...rest)) as typeof lib.client.call);
    await click(action()!);
    await settle();
    expect(live('alert')).toContain(p.failed.replace('{name}', 'Ana M.'));
    expect(await phraseOf(lib)).toBe('');
  });
});

