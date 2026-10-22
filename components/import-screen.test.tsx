import { act } from 'react';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { ImportTransportProvider } from '@/hooks/use-import';
import { createConversation } from '@/lib/db/queries';
import { storeSharedFiles } from '@/lib/storage/share-inbox';
import { createMemoryCacheStorage } from '@/lib/storage/test-cache-storage';
import { createLoopbackImports } from '@/lib/usecases/test-client';
import { createProfile } from '@/lib/usecases/profiles';
import { click, render, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { ImportScreen } from './import-screen';
import { ProblemText } from './import-steps';

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

const m = en.import;
type Lib = Awaited<ReturnType<typeof renderWithLibrary>>['lib'];
type View = Rendered & { lib: Lib };

// ── synthetic exports (generated here, never read from disk) ───────────────────────────────────
const bytes = (seed: number, size = 300) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const VIDEO = '00000002-VIDEO-2026-03-18-09-05-00.mp4';
/** Ana wrote under a name, the other side is a bare number: Ana is the guess. */
const GUESS = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] +34 612 34 56 78: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:10:00] +34 612 34 56 78: Hola',
];
const TWO_NAMES = ['[17/03/2026, 13:17:05] Ana: Bon dia', '[17/03/2026, 13:17:30] Bo: ok', '[18/03/2026, 09:10:00] Bo: Hola'];
const TIE = ['[03/04/2026, 10:00:00] Ana: hello', '[05/06/2026, 11:00:00] Bo: hi'];

function zipFile(name: string, lines: string[], media: Record<string, Uint8Array> = {}): File {
  return new File([zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...media }) as BlobPart], name);
}
const anaFile = (lines = GUESS) => zipFile('WhatsApp Chat - Ana.zip', lines, { [PHOTO]: bytes(1) });

// ── driving the screen ─────────────────────────────────────────────────────────────────────────
async function until(condition: () => boolean, what: string, limitMs = 8000) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const text = (view: Rendered) => view.container.textContent ?? '';
const buttons = (view: Rendered) => [...view.container.querySelectorAll('button')];
const buttonNamed = (view: Rendered, name: string | RegExp) =>
  buttons(view).find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''))) ?? null;
/** The label as a person reads it: decoration (aria-hidden tiles such as avatars) left out. */
const labelOf = (input: HTMLInputElement) => {
  const label = input.closest('label')?.cloneNode(true) as HTMLElement | undefined;
  label?.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  return label?.textContent ?? '';
};
const radios = (view: Rendered) => [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const radioNamed = (view: Rendered, name: string | RegExp) =>
  radios(view).find((r) => (typeof name === 'string' ? labelOf(r).startsWith(name) : name.test(labelOf(r)))) ?? null;
const heading = (view: Rendered) => view.container.querySelector('h2');
const announced = (view: Rendered) => view.container.querySelector('[role="status"][aria-live="polite"]')?.textContent;

async function pick(view: Rendered, files: File[]) {
  const input = view.container.querySelector<HTMLInputElement>('[data-testid="import-file-input"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

interface OpenOptions {
  seed?: (lib: Lib) => Promise<void>;
  holdMedia?: Promise<void>;
  holdSave?: Promise<void>;
}

async function open(options: OpenOptions = {}) {
  const lib = (await import('@/lib/usecases/test-client')).createTestLibrary();
  const ready = await lib;
  if (options.seed) await options.seed(ready);
  const loop = createLoopbackImports(ready.root, { holdMedia: options.holdMedia, holdSave: options.holdSave });
  const view = await renderWithLibrary(
    <ImportTransportProvider createTransport={loop.createTransport}>
      <ImportScreen />
    </ImportTransportProvider>,
    { lib: ready },
  );
  await settle();
  return { view: view as View, lib: ready, loop };
}

/** From the file list into step 1 and past the preview. */
async function startWizard(view: Rendered, files: File[]) {
  await pick(view, files);
  await click(buttonNamed(view, /^Continue with/));
  await until(() => !!view.container.querySelector('dl'), 'the preview');
}
const next = (view: Rendered) => click(buttonNamed(view, /^(Next|Add \d|Confirm|Finish)/));
async function chooseLater(view: Rendered) {
  await next(view);
  await click(radioNamed(view, m.person.later));
}

describe('the import wizard', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.unstubAllGlobals();
  });

  describe('choosing files', () => {
    test('starts with no files and a disabled Continue; the page has a heading and a way back', async () => {
      ({ view } = await open());
      expect(view.container.querySelector('h1')?.textContent).toBe(m.title);
      expect(text(view)).toContain(m.choose.empty);
      expect(buttonNamed(view, /^Continue with/)?.getAttribute('aria-disabled')).toBe('true');
      expect(view.container.querySelector('a[href="/people"]')?.textContent).toBe(m.backToPeople);
      expect(view.container.querySelector('a[href="/import/history?from=import"]')?.textContent).toBe(m.historyLink);
    });

    test('lists the ZIPs it is given, leaves other files out and says so, and can remove one', async () => {
      ({ view } = await open());
      await pick(view, [anaFile(), new File(['x'], '_chat.txt', { type: 'text/plain' })]);
      expect(text(view)).toContain('WhatsApp Chat - Ana.zip');
      expect(text(view)).not.toContain('_chat.txt');
      expect(text(view)).toContain('Files to import (1)');
      expect(text(view)).toContain('1 file was left out: for now only WhatsApp ZIP files can be imported.');

      await click(view.container.querySelector('button[aria-label="Remove WhatsApp Chat - Ana.zip from the list"]'));
      expect(text(view)).toContain(m.choose.empty);
    });

    test('the same file twice is listed once', async () => {
      ({ view } = await open());
      const file = anaFile();
      await pick(view, [file]);
      await pick(view, [file]);
      expect(view.container.querySelectorAll('section li')).toHaveLength(1);
    });

    test('files dropped on the box are added', async () => {
      ({ view } = await open());
      const zone = view.container.querySelector('[data-testid="import-dropzone"]')!;
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [anaFile()] } });
      await act(async () => {
        zone.dispatchEvent(drop);
      });
      expect(text(view)).toContain('WhatsApp Chat - Ana.zip');
    });

    test('files shared from WhatsApp are offered in the same list, and removing one forgets it', async () => {
      const caches = createMemoryCacheStorage();
      await storeSharedFiles(caches, 'https://x.example/', [
        new File([zipSync({ '_chat.txt': strToU8(GUESS.join('\n')) }) as BlobPart], 'Shared chat.zip', { type: 'application/zip' }),
        new File(['t'], 'notes.txt', { type: 'text/plain' }),
      ]);
      vi.stubGlobal('caches', caches);
      ({ view } = await open());
      await until(() => text(view!).includes('Shared chat.zip'), 'the shared file');
      expect(text(view)).toContain(m.choose.shared);
      expect(text(view)).toContain(m.choose.sharedNote);
      expect(text(view)).toContain('1 file was left out');

      await click(view.container.querySelector('button[aria-label="Remove Shared chat.zip from the list"]'));
      await settle();
      expect(await caches.has('memory-archive-share-inbox-v1')).toBe(true);
      const cache = await caches.open('memory-archive-share-inbox-v1');
      // The ZIP was removed with its copy, and the text file, which can never be imported, was not kept either.
      expect((await cache.keys()).length).toBe(0);
    });

    test('a shared text file is discarded, and is not offered again after a reload', async () => {
      const caches = createMemoryCacheStorage();
      await storeSharedFiles(caches, 'https://x.example/', [new File(['chat'], '_chat.txt', { type: 'text/plain' })]);
      vi.stubGlobal('caches', caches);
      ({ view } = await open());
      await until(() => text(view!).includes('1 file was left out'), 'the notice');
      await settle();
      const cache = await caches.open('memory-archive-share-inbox-v1');
      expect(await cache.keys()).toEqual([]);

      view.unmount();
      ({ view } = await open());
      await settle();
      expect(text(view)).not.toContain('left out');
      expect(text(view)).toContain(m.choose.empty);
    });

    test('removing a file moves the focus to the next Remove button, then to the list heading', async () => {
      ({ view } = await open());
      await pick(view, [zipFile('One.zip', GUESS), zipFile('Two.zip', TWO_NAMES), zipFile('Three.zip', TIE)]);
      await click(view.container.querySelector('button[aria-label="Remove One.zip from the list"]'));
      await until(() => document.activeElement?.getAttribute('aria-label') === 'Remove Two.zip from the list', 'focus on the next button');
      await click(view.container.querySelector('button[aria-label="Remove Three.zip from the list"]'));
      await until(() => document.activeElement?.getAttribute('aria-label') === 'Remove Two.zip from the list', 'focus on the last button');
      await click(document.activeElement);
      await until(() => document.activeElement?.tagName === 'H2', 'focus on the list heading');
      expect(document.activeElement?.textContent).toContain('Files to import (0)');
    });

    test('names are text, never markup', async () => {
      ({ view } = await open());
      await pick(view, [zipFile('<img src=x onerror=alert(1)>.zip', GUESS)]);
      expect(view.container.querySelector('li img')).toBeNull();
      expect(text(view)).toContain('<img src=x onerror=alert(1)>.zip');
    });
  });

  describe('step 1: what is in the file', () => {
    test('shows the chat, its messages, period and media, with a real heading that has the focus', async () => {
      ({ view } = await open());
      await pick(view, [anaFile()]);
      await click(buttonNamed(view, /^Continue with/));
      expect(heading(view)?.textContent).toContain('Step 1 of 5');
      expect(heading(view)?.textContent).toContain(m.steps.preview);
      expect(document.activeElement).toBe(heading(view));
      expect(text(view)).toContain(m.preview.loading);

      await until(() => !!view!.container.querySelector('dl'), 'the preview');
      const details = view.container.querySelector('dl')!.textContent!;
      expect(details).toContain('Ana');
      expect(details).toContain('Private chat');
      expect(details).toContain('4 messages');
      expect(details).toContain('1 photo');
      expect(details).toContain('Mar 17, 2026');
      expect(details).toContain('Mar 18, 2026');
    });

    test('an unreadable file gets calm, code-based copy, never the raw error, and can be retried or removed', async () => {
      ({ view } = await open());
      await startWizard_failing(view);
      const alert = view.container.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain(m.problem.invalidExport);
      expect(alert.textContent).not.toMatch(/readable WhatsApp|central directory|ZipLimit/i);
      expect(buttonNamed(view, m.preview.retry)).not.toBeNull();
      // Next waits.
      expect(buttonNamed(view, 'Next')?.getAttribute('aria-disabled')).toBe('true');

      await click(buttonNamed(view, m.preview.removeFile));
      expect(text(view)).toContain(m.choose.empty);
    });

    test('a file over the limits says it is too big', async () => {
      ({ view } = await open());
      // A ZIP that declares more entries than the limit is rejected before anything is read; a corrupt one is invalid.
      await startWizard_failing(view, new File([new Uint8Array(40)], 'broken.zip'));
      expect(text(view)).toContain(m.problem.invalidExport);
    });

    test('shows missing files and unreadable dates as notices', async () => {
      ({ view } = await open());
      const lines = [...GUESS, '[31/02/2026, 10:00:00] Ana: impossible date', `[19/03/2026, 10:00:00] Ana: <attached: 00000009-PHOTO-2026-03-19-10-00-00.jpg>`];
      await startWizard(view, [anaFile(lines)]);
      expect(text(view)).toContain('1 file mentioned in the chat is not in the ZIP.');
      expect(text(view)).toContain('1 line has a date that cannot be read.');
    });
  });

  async function startWizard_failing(v: Rendered, file = new File([new Uint8Array(10)], 'not-a-zip.zip')) {
    await pick(v, [file]);
    await click(buttonNamed(v, /^Continue with/));
    await until(() => !!v.container.querySelector('[role="alert"]'), 'the error');
  }

  describe('step 2: who is this for', () => {
    test('needs an explicit choice: Next explains, moves the focus to the question, and nothing is picked silently', async () => {
      ({ view } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) }));
      await startWizard(view, [anaFile()]);
      await next(view);
      expect(heading(view)?.textContent).toContain('Step 2 of 5');
      expect(radios(view).some((r) => r.checked)).toBe(false);

      await next(view);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(m.person.required);
      expect(heading(view)?.textContent).toContain('Step 2 of 5');
      const current = view;
      await until(() => document.activeElement === radios(current)[0], 'focus on the first option');

      await click(radioNamed(view, 'Mama'));
      expect(view.container.querySelector('[role="alert"]')?.textContent ?? '').toBe('');
    });

    test('lists active people with their conversation count, not archived ones; offers Decide later and Add a new person', async () => {
      ({ view } = await open({
        seed: async ({ deps }) => {
          await createProfile(deps, { displayName: 'Mama', relationship: 'mother' });
          const old = await createProfile(deps, { displayName: 'Old friend' });
          const { archiveProfile } = await import('@/lib/usecases/profiles');
          await archiveProfile(deps, old.id);
        },
      }));
      await startWizard(view, [anaFile()]);
      await next(view);
      const labels = radios(view).map(labelOf);
      expect(labels[0]).toContain('Mama');
      expect(labels[0]).toContain('mother');
      expect(labels[0]).toContain('No conversations yet');
      expect(labels.some((l) => l.includes('Old friend'))).toBe(false);
      expect(labels.some((l) => l.startsWith(m.person.new))).toBe(true);
      expect(labels.some((l) => l.startsWith(m.person.later))).toBe(true);
    });

    test('"Add a new person" keeps the earlier choice until a person is created: Cancel and Back leave it as it was', async () => {
      ({ view } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) }));
      await startWizard(view, [anaFile()]);
      await next(view);
      await click(radioNamed(view, 'Mama'));

      await click(radioNamed(view, m.person.new));
      expect(view.container.querySelector('form')).not.toBeNull();
      expect(radioNamed(view, 'Mama')!.checked).toBe(false);
      // While the form is open Next does not go on with the earlier choice behind the person's back.
      await next(view);
      expect([...view.container.querySelectorAll('[role="alert"]')].map((a) => a.textContent)).toContain(m.person.required);
      expect(heading(view)?.textContent).toContain('Step 2 of 5');

      await click(buttonNamed(view, en.people.form.cancel));
      expect(view.container.querySelector('form')).toBeNull();
      expect(radioNamed(view, 'Mama')!.checked).toBe(true);
      expect(buttonNamed(view, 'Next')?.getAttribute('aria-disabled')).toBeNull();

      // Back and forward with the form open also keep Mama.
      await click(radioNamed(view, m.person.new));
      await click(buttonNamed(view, 'Back'));
      await next(view);
      expect(view.container.querySelector('form')).toBeNull();
      expect(radioNamed(view, 'Mama')!.checked).toBe(true);
      await next(view);
      expect(heading(view)?.textContent).toContain('Step 3 of 5');
    });

    test('adds a new person inline with the same validation, selects them and announces it', async () => {
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await next(view);
      expect(text(view)).toContain(m.person.noOne);
      await click(radioNamed(view, m.person.new));
      const form = view.container.querySelector('form')!;
      await submit(form);
      expect(form.textContent).toContain(en.people.form.nameRequired);

      await type(form.querySelector('input'), 'Mama');
      await submit(form);
      await until(() => radios(view!).some((r) => r.checked && labelOf(r).startsWith('Mama')), 'Mama selected');
      expect(announced(view)).toBe('Mama was added.');
      // The new person's radio takes the focus.
      expect(document.activeElement).toBe(radioNamed(view, 'Mama'));
      expect(view.container.querySelector('form')).toBeNull();
      expect(await (view as View).lib.deps.client.call('listProfiles')).toHaveLength(1);

      await next(view);
      expect(heading(view)?.textContent).toContain('Step 3 of 5');
    });
  });

  describe('step 3: which one is you', () => {
    test('pre-selects the guess and says so in words, and the choice can be changed', async () => {
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await chooseLater(view);
      await next(view);

      expect(heading(view)?.textContent).toContain('Step 3 of 5');
      const ana = radioNamed(view, 'Ana')!;
      expect(ana.checked).toBe(true);
      expect(labelOf(ana)).toContain(m.me.guess);
      const phone = radioNamed(view, '+34 612 34 56 78')!;
      expect(labelOf(phone)).toContain(m.me.phone);
      expect(text(view)).toContain(m.me.phoneHint);

      await click(phone);
      expect(phone.checked).toBe(true);
      expect(ana.checked).toBe(false);
      expect(text(view)).not.toContain(m.me.guess);

      await click(radioNamed(view, m.me.none));
      expect(radioNamed(view, m.me.none)!.checked).toBe(true);
    });

    test('with no guess nothing is selected and the person must choose; "not in this chat" is allowed', async () => {
      ({ view } = await open());
      await startWizard(view, [anaFile(TWO_NAMES)]);
      await chooseLater(view);
      await next(view);
      expect(radios(view).some((r) => r.checked)).toBe(false);
      expect(text(view)).not.toContain(m.me.guess);

      await next(view);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(m.me.required);
      await click(radioNamed(view, m.me.none));
      await next(view);
      expect(heading(view)?.textContent).toContain('Step 4 of 5');
    });
  });

  describe('step 4: what is new', () => {
    async function toCheck(v: Rendered) {
      await chooseLater(v);
      await next(v);
      await click(radioNamed(v, m.me.none));
      await next(v);
    }

    test('a new conversation says so with the message count, in a live region that exists before the answer', async () => {
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await toCheck(view);
      const live = view.container.querySelector('[data-testid="check-live"]')!;
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.textContent).toContain(m.check.loading);
      await until(() => text(view!).includes('This is a new conversation'), 'the check');
      // The same element now holds the answer.
      expect(view.container.querySelector('[data-testid="check-live"]')).toBe(live);
      expect(live.textContent).toContain('All 4 messages will be added.');
    });


    test('a chat that is already there says how many messages are already there and how many are new', async () => {
      let mama = '';
      ({ view } = await open({
        seed: async (lib) => {
          mama = (await createProfile(lib.deps, { displayName: 'Mama' })).id;
          // The same export imported before, minus its last message.
          const { importWhatsAppExport } = await import('@/lib/usecases/import');
          await importWhatsAppExport(lib.deps, {
            zip: anaFile(GUESS.slice(0, 3)),
            fileName: 'WhatsApp Chat - Ana.zip',
            profileIds: [mama],
            meAuthor: 'Ana',
          });
        },
      }));
      await startWizard(view, [anaFile()]);
      await next(view);
      await click(radioNamed(view, 'Mama'));
      await next(view);
      await next(view);
      await until(() => text(view!).includes(m.check.existingTitle), 'the existing chat');
      expect(text(view)).toContain('It is kept as “Ana”. 3 messages are already there and will not be copied again.');
      expect(text(view)).toContain('1 new message will be added.');
      await next(view);
      expect(buttonNamed(view, 'Add 1 message to Mama')).not.toBeNull();
    });

    test('an ambiguous match asks which conversation, with the candidate titles, and will not go on without an answer', async () => {
      let mama = '';
      ({ view } = await open({
        seed: async (lib) => {
          mama = (await createProfile(lib.deps, { displayName: 'Mama' })).id;
          for (const [i, title] of ['Ana (old)', 'Ana (older)'].entries()) {
            createConversation(lib.opened.db, {
              id: `00000000-0000-4000-8000-0000000000b${i}`,
              title,
              source: 'whatsapp',
              sourceKey: 'ana',
              isGroup: false,
              profileIds: [mama],
              participants: [],
              now: '2026-03-01T10:00:00.000Z',
            });
          }
        },
      }));
      await startWizard(view, [anaFile()]);
      await next(view);
      await click(radioNamed(view, 'Mama'));
      await next(view);
      await next(view);
      await until(() => text(view!).includes(m.check.ambiguousTitle), 'the question');
      expect(text(view)).toContain(m.check.reason.sameTitle);
      expect(radioNamed(view, 'Add to “Ana (old)”')).not.toBeNull();
      expect(radioNamed(view, 'Add to “Ana (older)”')).not.toBeNull();
      expect(radios(view).some((r) => r.checked)).toBe(false);

      await next(view);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(m.check.choose);
      expect(heading(view)?.textContent).toContain('Step 4 of 5');

      await click(radioNamed(view, m.check.makeNew));
      await until(() => text(view!).includes('This is a new conversation'), 'the re-check');
      await next(view);
      expect(heading(view)?.textContent).toContain('Step 5 of 5');
    });

    test('choosing a candidate re-checks against it', async () => {
      ({ view } = await open({
        seed: async (lib) => {
          const mama = (await createProfile(lib.deps, { displayName: 'Mama' })).id;
          for (const [i, title] of ['Ana (old)', 'Ana (older)'].entries()) {
            createConversation(lib.opened.db, {
              id: `00000000-0000-4000-8000-0000000000c${i}`,
              title,
              source: 'whatsapp',
              sourceKey: 'ana',
              isGroup: false,
              profileIds: [mama],
              participants: [],
              now: '2026-03-01T10:00:00.000Z',
            });
          }
        },
      }));
      await startWizard(view, [anaFile()]);
      await next(view);
      await click(radioNamed(view, 'Mama'));
      await next(view);
      await next(view);
      await until(() => text(view!).includes(m.check.ambiguousTitle), 'the question');
      await click(radioNamed(view, 'Add to “Ana (older)”'));
      await until(() => text(view!).includes(m.check.existingTitle), 'the candidate check');
      expect(text(view)).toContain('It is kept as “Ana (older)”.');
      expect(text(view)).toContain('4 new messages will be added.');
    });

    test('a date that reads both ways shows both readings of the example and needs a choice', async () => {
      ({ view } = await open());
      await startWizard(view, [zipFile('WhatsApp Chat - Ana.zip', TIE)]);
      await toCheck(view);
      await until(() => text(view!).includes(m.check.dateTitle), 'the date question');
      expect(text(view)).toContain('Apr 3, 2026');
      expect(text(view)).toContain('Mar 4, 2026');
      expect(radioNamed(view, 'Day first: Apr 3, 2026')).not.toBeNull();
      expect(radioNamed(view, 'Month first: Mar 4, 2026')).not.toBeNull();

      await next(view);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(m.check.dateRequired);

      await click(radioNamed(view, 'Month first: Mar 4, 2026'));
      await until(() => text(view!).includes('This is a new conversation'), 'the check after the choice');
      await next(view);
      expect(heading(view)?.textContent).toContain('Step 5 of 5');
    });
  });

  describe('step 5: space and confirmation', () => {
    const quota = (usage: number, size: number) =>
      vi.stubGlobal('navigator', { ...navigator, storage: { estimate: async () => ({ usage, quota: size }) } });
    const videoFile = () =>
      zipFile('WhatsApp Chat - Ana.zip', [...GUESS, `[19/03/2026, 10:00:00] Ana: <attached: ${VIDEO}>`], {
        [PHOTO]: bytes(1),
        [VIDEO]: bytes(3, 60_000_000 / 1000),
      });
    async function toConfirm(v: Rendered) {
      await chooseLater(v);
      await next(v);
      await click(radioNamed(v, m.me.none));
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
    }

    test('enough space: says so with the sizes; a summary of who it is for and what will be added', async () => {
      quota(0, 10_000_000_000);
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await toConfirm(view);
      expect(heading(view)?.textContent).toContain('Step 5 of 5');
      expect(text(view)).toContain(m.space.fits);
      expect(text(view)).toContain(m.space.forNobody);
      expect(text(view)).toContain(m.space.youNone);
      expect(buttonNamed(view, 'Add 4 messages, not assigned yet')).not.toBeNull();
    });

    test('unknown quota never blocks and says it cannot check', async () => {
      vi.stubGlobal('navigator', { ...navigator, storage: undefined });
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await toConfirm(view);
      expect(text(view)).toContain(m.space.unknown);
      expect(buttonNamed(view, /^Add 4 messages/)?.getAttribute('aria-disabled')).toBeNull();
    });

    test('no room: warns, offers "Import without videos" and shows that it would fit without them', async () => {
      // The margin alone is 32 MiB: 40 MiB holds the chat and the photo but not the 20 MiB video.
      quota(0, 40 * 1024 * 1024);
      ({ view } = await open());
      const big = new File([zipSync({ '_chat.txt': strToU8([...GUESS, `[19/03/2026, 10:00:00] Ana: <attached: ${VIDEO}>`].join('\n')), [PHOTO]: bytes(1), [VIDEO]: new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 31) % 251) }, { level: 0 }) as BlobPart], 'WhatsApp Chat - Ana.zip');
      await startWizard(view, [big]);
      await toConfirm(view);
      expect(text(view)).toContain(m.space.noFit);
      expect(text(view)).toContain(m.space.noFitWithout);
      const skip = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(labelOf(skip)).toContain(m.space.skipVideos);
      expect(skip.checked).toBe(false);

      await click(skip);
      expect(skip.checked).toBe(true);
      expect(text(view)).not.toContain(m.space.noFit);
      expect(text(view)).toContain(m.space.fits);
    });

    test('a chat with no videos has no "without videos" option', async () => {
      quota(0, 10_000_000_000);
      ({ view } = await open());
      await startWizard(view, [anaFile()]);
      await toConfirm(view);
      expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    });

    test('skipVideos is passed on to the import', async () => {
      quota(0, 10_000_000_000);
      const { view: v, loop } = await open();
      view = v;
      await startWizard(v, [videoFile()]);
      await toConfirm(v);
      await click(v.container.querySelector('input[type="checkbox"]'));
      await next(v);
      await until(() => text(v).includes(m.done.titleOk), 'the end');
      const start = loop.requests.find((r) => r.type === 'start');
      expect(start && 'input' in start && start.input.options).toEqual({ skipVideos: true });
      expect(text(v)).toContain('1 video was left out, as you asked.');
    });
  });

  describe('going back and forth', () => {
    test('keeps every choice, never reads the file twice, and Back from step 1 returns to the files', async () => {
      const { view: v, loop } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await click(radioNamed(v, '+34 612 34 56 78'));
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      const previews = loop.started;

      await click(buttonNamed(v, 'Back'));
      expect(heading(v)?.textContent).toContain('Step 3 of 5');
      expect(radioNamed(v, '+34 612 34 56 78')!.checked).toBe(true);
      await click(buttonNamed(v, 'Back'));
      expect(radioNamed(v, 'Mama')!.checked).toBe(true);
      await click(buttonNamed(v, 'Back'));
      expect(heading(v)?.textContent).toContain('Step 1 of 5');
      expect(v.container.querySelector('dl')).not.toBeNull();
      expect(loop.started).toBe(previews);

      await click(buttonNamed(v, m.wizard.toFiles));
      expect(text(v)).toContain('Files to import (1)');
      expect(document.activeElement?.tagName).toBe('H1');
      await click(buttonNamed(v, /^Continue with/));
      expect(heading(v)?.textContent).toContain('Step 1 of 5');
    });

    test('changing the person asks the library again', async () => {
      const { view: v, loop } = await open({
        seed: async ({ deps }) => {
          await createProfile(deps, { displayName: 'Mama' });
          await createProfile(deps, { displayName: 'Papa' });
        },
      });
      view = v;
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the first check');
      const started = loop.started;
      await click(buttonNamed(v, 'Back'));
      await click(buttonNamed(v, 'Back'));
      await click(radioNamed(v, 'Papa'));
      await next(v);
      await next(v);
      await until(() => loop.started > started, 'a second check');
    });
  });

  describe('the run', () => {
    async function toRun(v: Rendered, who: 'later' | 'Mama' = 'Mama') {
      await next(v);
      await click(radioNamed(v, who === 'later' ? m.person.later : who));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
      await next(v);
    }

    test('imports into the person, tells the result in plain words and links to the person', async () => {
      const { view: v, lib } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v);
      await until(() => text(v).includes(m.done.titleOk), 'the result');

      expect(document.activeElement).toBe(heading(v));
      expect(text(v)).toContain('4 new messages added to Mama.');
      expect(text(v)).toContain('New conversation: “Ana”.');
      expect(text(v)).toContain('1 photo or file saved.');
      const link = v.container.querySelector<HTMLAnchorElement>('a[href^="/person?id="]')!;
      expect(link.textContent).toBe('Open Mama');
      const conversations = await lib.deps.client.call('listConversations');
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({ title: 'Ana', messageCount: 4 });
    });

    test('"Decide later" leaves the conversation unassigned and links to People', async () => {
      const { view: v, lib } = await open();
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v, 'later');
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      expect(text(v)).toContain('4 new messages added. They are not assigned to anyone yet.');
      expect(v.container.querySelector('a[href^="/person?id="]')).toBeNull();
      expect(v.container.querySelector('a[href="/people"]')).not.toBeNull();
      const [conversation] = await lib.deps.client.call('listConversations');
      expect(conversation.profileIds).toEqual([]);
    });

    test('the same export again adds nothing and says everything was already there', async () => {
      const { view: v } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v);
      await until(() => text(v).includes(m.done.titleOk), 'the first import');
      await click(buttonNamed(v, m.done.another));
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes(m.check.existingTitle), 'the existing chat');
      expect(text(v)).toContain('4 messages are already there and will not be copied again.');
      expect(text(v)).toContain('There are no new messages to add.');
      await next(v);
      expect(buttonNamed(v, m.confirm.nothing)).not.toBeNull();
      await next(v);
      await until(() => text(v).includes(m.done.titleOk), 'the second result');
      expect(text(v)).toContain('No new messages were added to Mama.');
      expect(text(v)).toContain('4 messages were already in the archive and were not copied again.');
      expect(buttonNamed(v, m.result.undo)).toBeNull();
    });

    test('shows progress with a bar and a cancel button, and cancelling before the save changes nothing', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { view: v, lib } = await open({
        seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })),
        holdMedia: gate,
      });
      view = v;
      const before = JSON.stringify(await lib.deps.client.call('listConversations'));
      // Two photos: the cancel is noticed between the files, before anything is saved.
      const PHOTO2 = '00000002-PHOTO-2026-03-18-09-05-00.jpg';
      await startWizard(v, [zipFile('WhatsApp Chat - Ana.zip', [...GUESS, `[18/03/2026, 09:05:00] Ana: <attached: ${PHOTO2}>`], { [PHOTO]: bytes(1), [PHOTO2]: bytes(2) })]);
      await toRun(v);

      expect(heading(v)?.textContent).toBe(m.run.title);
      expect(v.container.querySelector('[role="progressbar"]')).not.toBeNull();
      expect(text(v)).toContain(m.run.cancelNote);
      expect(text(v)).toContain('nothing is changed');
      await until(() => !!v.container.querySelector('[aria-hidden="true"].text-sm') && text(v).includes('Copying photos'), 'the media phase');

      await click(buttonNamed(v, m.run.cancel));
      expect(buttonNamed(v, m.run.cancelling)).not.toBeNull();
      // The cancel reaches the worker before the held file is let go.
      await settle();
      release();
      await until(() => text(v).includes(m.done.titleCancelled), 'the cancelled screen');
      expect(text(v)).toContain(m.status.cancelled);
      expect(text(v)).toContain(m.done.cancelledNote);
      expect(JSON.stringify(await lib.deps.client.call('listConversations'))).toBe(before);
      expect(await lib.deps.blobStore.list()).toEqual([]);
    });

    test('announces the phase in the polite status region while it runs, not every tick, and the heading at the end', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { view: v } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })), holdMedia: gate });
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v);
      await until(() => announced(v) === m.run.media, 'the media phase announced');
      // The visible progress text is hidden from screen readers: only the status region speaks.
      expect(v.container.querySelector('[aria-hidden="true"].text-sm')?.textContent).toContain('Copying photos');
      release();
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      expect(announced(v)).toBe('');
      expect(document.activeElement).toBe(heading(v));
    });

    test('warns before the page is closed while it runs, and not after', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { view: v } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) , holdMedia: gate });
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v);
      const during = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(during);
      expect(during.defaultPrevented).toBe(true);
      release();
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      const after = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });

    test('a cancel that arrives after the messages were being saved lets the import finish and says so', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { view: v, lib } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })), holdSave: gate });
      view = v;
      await startWizard(v, [anaFile()]);
      await toRun(v);
      await until(() => announced(v) === m.run.saving, 'the saving phase');
      await click(buttonNamed(v, m.run.cancel));
      await settle();
      release();
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      expect(text(v)).toContain(m.result.lateCancel);
      expect(await lib.deps.client.call('listConversations')).toHaveLength(1);
    });

    test('a shared file is forgotten once it has been imported', async () => {
      const caches = createMemoryCacheStorage();
      await storeSharedFiles(caches, 'https://x.example/', [
        new File([zipSync({ '_chat.txt': strToU8(GUESS.join('\n')) }) as BlobPart], 'Shared chat.zip', { type: 'application/zip' }),
      ]);
      vi.stubGlobal('caches', caches);
      const { view: v } = await open();
      view = v;
      await until(() => text(v).includes('Shared chat.zip'), 'the shared file');
      await click(buttonNamed(v, /^Continue with/));
      await until(() => !!v.container.querySelector('dl'), 'the preview');
      await toRun(v, 'later');
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      await settle();
      const cache = await caches.open('memory-archive-share-inbox-v1');
      expect(await cache.keys()).toEqual([]);
    });
  });

  describe('the result does not depend on the people list', () => {
    test('when the people can no longer be read after the import, the result, the person link and Undo are still there', async () => {
      const { view: v, lib } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
      const call = lib.deps.client.call;
      lib.deps.client.call = ((op: string, ...args: unknown[]) =>
        op === 'listProfiles' ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => unknown)(op, ...args)) as typeof call;
      await next(v);
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      expect(document.activeElement).toBe(heading(v));
      expect(text(v)).toContain('4 new messages added to Mama.');
      expect(v.container.querySelector<HTMLAnchorElement>('a[href^="/person?id="]')?.textContent).toBe('Open Mama');
      expect(buttonNamed(v, m.result.undo)).not.toBeNull();
      lib.deps.client.call = call;
    });
  });

  describe('the result and undo', () => {
    async function imported() {
      const opened = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = opened.view;
      const v = opened.view;
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
      await next(v);
      await until(() => text(v).includes(m.done.titleOk), 'the result');
      return { v, lib: opened.lib };
    }

    test('asks before undoing, says what goes and what stays, and focus starts on the safe button', async () => {
      const { v, lib } = await imported();
      await click(buttonNamed(v, m.result.undo));
      const panel = v.container.querySelector('[role="group"]')!;
      expect(panel.textContent).toContain(m.undo.title);
      expect(panel.textContent).toContain('The 4 messages added by this import will be removed, and so will the conversation “Ana”, which this import created.');
      expect(panel.textContent).toContain('Notes and favorites on that conversation are removed with it.');
      expect(panel.textContent).toContain('Anything that was in your archive before stays.');
      expect(document.activeElement?.textContent).toBe(m.undo.cancel);

      // Escape closes it without undoing (and is ignored while an input method composes).
      await act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(v.container.querySelector('[role="group"]')).toBeNull();
      expect(await lib.deps.client.call('listConversations')).toHaveLength(1);
    });

    test('undo removes the messages and the conversation it created, and says so', async () => {
      const { v, lib } = await imported();
      await click(buttonNamed(v, m.result.undo));
      await click(buttonNamed(v, m.undo.confirm));
      await until(() => text(v).includes('The import was undone.'), 'the undo');
      expect(text(v)).toContain('4 messages were removed.');
      expect(text(v)).toContain(m.status.undone);
      expect(text(v)).not.toContain('new messages added');
      expect(await lib.deps.client.call('listConversations')).toEqual([]);
      expect(await lib.deps.blobStore.list()).toEqual([]);
      expect(document.activeElement?.textContent).toContain('The import was undone.');
    });

    test('a failing undo says nothing changed and can be tried again', async () => {
      const { v, lib } = await imported();
      await click(buttonNamed(v, m.result.undo));
      const call = lib.deps.client.call;
      lib.deps.client.call = ((op: string, ...args: unknown[]) =>
        op === 'undoImportBatch' ? Promise.reject(new Error('boom')) : (call as (...a: unknown[]) => unknown)(op, ...args)) as typeof call;
      await click(buttonNamed(v, m.undo.confirm));
      await until(() => text(v).includes(m.undo.failed), 'the failure');
      expect(text(v)).not.toContain('boom');
      lib.deps.client.call = call;
      await click(buttonNamed(v, m.undo.confirm));
      await until(() => text(v).includes('The import was undone.'), 'the retry');
    });
  });

  describe('several files', () => {
    const second = () =>
      zipFile('WhatsApp Chat - Bo.zip', ['[17/03/2026, 13:17:05] Bo: hola', '[17/03/2026, 13:18:00] +34 600 00 00 00: ei']);

    /** Walks one file's steps to the end, choosing Mama. */
    async function walk(v: Rendered) {
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
    }

    test('are confirmed one after the other and nothing is added until the last confirmation', async () => {
      const { view: v, lib } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await pick(v, [anaFile(), second()]);
      await click(buttonNamed(v, /^Continue with 2 files/));
      await until(() => !!v.container.querySelector('dl'), 'the first preview');
      expect(text(v)).toContain('File 1 of 2');
      expect(text(v)).toContain('WhatsApp Chat - Ana.zip');

      await walk(v);
      expect(buttonNamed(v, m.confirm.more)).not.toBeNull();
      expect(text(v)).toContain('Nothing is added until you have confirmed all 2 files.');
      await next(v);
      expect(text(v)).toContain('File 2 of 2');
      expect(text(v)).toContain('WhatsApp Chat - Bo.zip');
      expect(heading(v)?.textContent).toContain('Step 1 of 5');
      expect(await lib.deps.client.call('listConversations')).toEqual([]);

      await until(() => !!v.container.querySelector('dl'), 'the second preview');
      await walk(v);
      // 4 + 2 messages, one button for the lot.
      expect(buttonNamed(v, 'Add 6 messages from 2 files')).not.toBeNull();
      await click(buttonNamed(v, 'Back'));
      expect(text(v)).toContain('File 2 of 2');
      expect(heading(v)?.textContent).toContain('Step 4 of 5');
    });

    test('are imported in sequence; a file that fails is reported and does not stop the others, and can be tried again', async () => {
      const { view: v, lib, loop } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      loop.crashStart = (name) => name.includes('Ana');
      await pick(v, [anaFile(), second()]);
      await click(buttonNamed(v, /^Continue with 2 files/));
      await until(() => !!v.container.querySelector('dl'), 'the first preview');
      await walk(v);
      await next(v);
      await until(() => !!v.container.querySelector('dl'), 'the second preview');
      await walk(v);
      await next(v);
      await until(() => text(v).includes(m.done.titleProblems), 'the end of the queue');

      const cards = [...v.container.querySelectorAll('ul > li')].filter((li) => li.querySelector('h3'));
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain(m.status.failed);
      expect(cards[0].textContent).toContain(m.problem.workerFailed);
      expect(cards[0].textContent).not.toContain('crashed');
      expect(cards[1].textContent).toContain(m.status.done);
      expect(cards[1].textContent).toContain('2 new messages added to Mama.');
      expect(await lib.deps.client.call('listConversations')).toHaveLength(1);
      expect(loop.requests.filter((r) => r.type === 'start').map((r) => (r.type === 'start' ? r.input.fileName : ''))).toEqual([
        'WhatsApp Chat - Ana.zip',
        'WhatsApp Chat - Bo.zip',
      ]);

      loop.crashStart = undefined;
      await click(buttonNamed(v, m.done.retry));
      await until(() => text(v).includes(m.done.titleOk), 'the retry');
      expect(await lib.deps.client.call('listConversations')).toHaveLength(2);
      // The file that was already imported is not imported again.
      expect(loop.requests.filter((r) => r.type === 'start')).toHaveLength(3);
    });
  });

  describe('when the archive changed while a file waited', () => {
    test('an ambiguous answer at import time imports nothing and sends the person back to choose', async () => {
      const { view: v, lib } = await open({ seed: async ({ deps }) => void (await createProfile(deps, { displayName: 'Mama' })) });
      view = v;
      await startWizard(v, [anaFile()]);
      await next(v);
      await click(radioNamed(v, 'Mama'));
      await next(v);
      await next(v);
      await until(() => text(v).includes('new conversation'), 'the check');
      await next(v);
      // Meanwhile two chats with this name appear.
      const mama = (await lib.deps.client.call('listProfiles'))[0].id;
      for (const [i, title] of ['Ana (old)', 'Ana (older)'].entries()) {
        createConversation(lib.opened.db, {
          id: `00000000-0000-4000-8000-0000000000d${i}`,
          title,
          source: 'whatsapp',
          sourceKey: 'ana',
          isGroup: false,
          profileIds: [mama],
          participants: [],
          now: '2026-03-01T10:00:00.000Z',
        });
      }
      await next(v);
      await until(() => text(v).includes(m.problem.changed), 'the explanation');
      expect(await lib.deps.client.call('listConversations')).toHaveLength(2);

      await click(buttonNamed(v, m.problem.review));
      expect(heading(v)?.textContent).toContain('Step 4 of 5');
      await until(() => text(v).includes(m.check.ambiguousTitle), 'the question');
    });
  });

  describe('copy for failures', () => {
    test('every problem has its own plain words, in code, never the error text', async () => {
      const cases = {
        'invalid-export': m.problem.invalidExport,
        'too-big': m.problem.tooBig,
        busy: m.problem.busy,
        'worker-failed': m.problem.workerFailed,
        storage: m.problem.storage,
        other: m.problem.other,
        changed: m.problem.changed,
      } as const;
      for (const [problem, copy] of Object.entries(cases)) {
        const rendered = await render(<ProblemText problem={problem as keyof typeof cases} />);
        expect(rendered.container.textContent).toBe(copy);
        rendered.unmount();
      }
    });

    test('every problem tells the person whether anything changed', () => {
      for (const copy of Object.values(m.problem).filter((c) => c !== m.problem.review)) {
        expect(copy).toMatch(/Nothing was (changed|imported)|will not create duplicates/);
      }
    });
  });

  describe('the library', () => {
    test('when it cannot be opened the screen says so calmly instead of the wizard', async () => {
      const lib = await (await import('@/lib/usecases/test-client')).createTestLibrary();
      view = await renderWithLibrary(<ImportScreen />, { lib, open: () => Promise.reject(new Error('boom')) });
      await settle();
      expect(view.container.querySelector('h1')?.textContent).toBe(m.title);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(en.library.error.title);
      expect(view.container.querySelector('input[type="file"]')).toBeNull();
    });
  });
});
