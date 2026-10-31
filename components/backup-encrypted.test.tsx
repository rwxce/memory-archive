import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { exportArchiveFromLibrary } from '@/lib/usecases/archive-backup';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { BackupScreen } from './backup-screen';

const download = vi.fn();
// happy-dom has no modal <dialog>: a local stand-in that toggles `open`.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  download.mockClear();
});
vi.mock('@/hooks/download-blob', () => ({ downloadBlob: (...args: unknown[]) => download(...args) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/backup',
}));

const b = en.backup;
const PASSWORD = 'a long phrase to remember';
const PROFILE = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

/** A library with one person (synthetic), so it is not empty. */
async function seeded(): Promise<Lib> {
  const lib = await createTestLibrary();
  lib.opened.db.run(
    "INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, 'Ana', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    [PROFILE],
  );
  return lib;
}

const button = (v: Rendered, name: string) => [...v.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === name);
const field = (v: Rendered, label: string) => {
  const el = [...v.container.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
  return el ? v.container.querySelector<HTMLInputElement>(`#${CSS.escape(el.htmlFor)}`) : null;
};
const pick = async (input: Element | null, file: File) => {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const toggle = (v: Rendered) => v.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
/** Key derivation takes real time and changes nothing on screen meanwhile, so wait for the outcome, not for quiet. */
async function until(condition: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  await settle();
}
const counts = (v: Rendered) => v.container.querySelector('[data-testid="backup-counts"]')!.textContent!;

let view: Rendered | undefined;
let encrypted: File;
let plain: File;

beforeAll(async () => {
  const source = await seeded();
  const sealed = await exportArchiveFromLibrary(source.deps, { appVersion: '1.0.0', password: PASSWORD });
  encrypted = new File([sealed.blob], sealed.fileName);
  const open = await exportArchiveFromLibrary(source.deps, { appVersion: '1.0.0' });
  plain = new File([open.blob], open.fileName);
}, 30_000);

afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('Making an encrypted backup', () => {
  test('a plain backup is marked private in the card and in the result', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    expect(view.container.querySelector('[data-testid="backup-protect-note"]')!.textContent).toBe(b.copy.privateNote);
    await click(button(view, b.copy.backup));
    await settle();
    expect(download.mock.calls[0][1]).toMatch(/\.zip$/);
    expect(view.container.textContent).toContain(en.archive.done.backupPrivate);
  });

  test('turning the switch on asks for a password twice and says a forgotten one cannot be recovered', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await click(toggle(view));
    const first = field(view, b.password.label)!;
    const second = field(view, b.password.confirmLabel)!;
    expect(first.type).toBe('password');
    expect(first.autocomplete).toBe('new-password');
    expect(second.type).toBe('password');
    expect(view.container.textContent).toContain(b.copy.protectNote);
    const reveal = button(view, b.password.showMany)!;
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    expect(reveal.getAttribute('aria-controls')).toBe(`${first.id} ${second.id}`);
    await click(reveal);
    expect(first.type).toBe('text');
    expect(second.type).toBe('text');
    // The label stays fixed; only the pressed state changes.
    expect(reveal.textContent).toBe(b.password.showMany);
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
  });

  test('a mismatch or an empty password blocks the backup, with the error beside the field', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await click(toggle(view));
    await click(button(view, b.copy.backup));
    expect(field(view, b.password.label)!.getAttribute('aria-invalid')).toBe('true');
    expect(view.container.textContent).toContain(b.password.empty);

    await type(field(view, b.password.label), PASSWORD);
    await type(field(view, b.password.confirmLabel), 'something else');
    await click(button(view, b.copy.backup));
    const confirm = field(view, b.password.confirmLabel)!;
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
    expect(view.container.querySelector(`#${CSS.escape(confirm.id)}-error`)!.textContent).toBe(b.password.mismatch);
    expect(document.activeElement).toBe(confirm);
    await settle();
    expect(download).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain(en.archive.done.backup);
  });

  test('matching passwords make an encrypted file, say so, and are cleared', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await click(toggle(view));
    await type(field(view, b.password.label), PASSWORD);
    await type(field(view, b.password.confirmLabel), PASSWORD);
    await click(button(view, b.copy.backup));
    await until(() => download.mock.calls.length > 0);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toMatch(/\.mabackup$/);
    expect(view.container.textContent).toContain(en.archive.done.backupEncrypted);
    expect(view.container.textContent).not.toContain(en.archive.done.backupPrivate);
    expect(field(view, b.password.label)!.value).toBe('');
    expect(field(view, b.password.confirmLabel)!.value).toBe('');
  });
});

describe('Opening a protected backup', () => {
  test('a protected file asks for its password before anything is opened', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="restore-input"]'), encrypted);
    await settle();
    const prompt = view.container.querySelector('[data-testid="password-prompt"]')!;
    expect(prompt.textContent).toContain(b.prompt.title);
    expect(document.activeElement).toBe(field(view, b.password.label));
    expect(counts(view)).toContain('0 people');
  });

  test('a wrong password changes nothing and can be retried without picking the file again', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="restore-input"]'), encrypted);
    await settle();
    await type(field(view, b.password.label), 'not the password');
    await submit(view.container.querySelector('[data-testid="password-prompt"]'));
    await until(() => view!.container.textContent!.includes(en.archive.error.wrongPassword));
    expect(view.container.querySelector('[data-testid="password-prompt"]')).not.toBeNull();
    expect(view.container.textContent).toContain(en.archive.error.wrongPassword);
    expect(field(view, b.password.label)!.value).toBe('');
    expect(counts(view)).toContain('0 people');

    await type(field(view, b.password.label), PASSWORD);
    await submit(view.container.querySelector('[data-testid="password-prompt"]'));
    await until(() => view!.container.textContent!.includes(en.archive.done.restore));
    expect(view.container.querySelector('[data-testid="password-prompt"]')).toBeNull();
    expect(counts(view)).toContain('1 person');
  });

  test('a plain backup opens straight away, with no password asked', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="restore-input"]'), plain);
    await settle();
    expect(view.container.querySelector('[data-testid="password-prompt"]')).toBeNull();
    expect(view.container.textContent).toContain(en.archive.done.restore);
    expect(counts(view)).toContain('1 person');
  });

  test('replacing: the dialog says the safety copy is not protected and asks for the password; a wrong one reopens it', async () => {
    const lib = await seeded();
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    await pick(view.container.querySelector('[data-testid="replace-input"]'), encrypted);
    await settle();
    const dialog = view.container.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(b.replace.safetyPlain);
    expect(dialog.textContent).toContain(b.replace.encrypted);
    expect(document.activeElement).toBe(field(view, b.password.label));

    // Confirming without a password does nothing.
    await click(button(view, b.replace.confirm));
    expect(dialog.open).toBe(true);
    expect(download).not.toHaveBeenCalled();

    await type(field(view, b.password.label), 'nope');
    await click(button(view, b.replace.confirm));
    await until(() => dialog.open && dialog.textContent!.includes(en.archive.error.wrongPassword));
    expect(download).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(en.archive.error.wrongPassword);
    expect(field(view, b.password.label)!.value).toBe('');

    await type(field(view, b.password.label), PASSWORD);
    await click(button(view, b.replace.confirm));
    await until(() => view!.container.textContent!.includes(en.archive.done.replace));
    expect(dialog.open).toBe(false);
    expect(download).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain(en.archive.done.replace);
  });

  test('a plain backup in the replace dialog has no password field but the same safety sentence', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await pick(view.container.querySelector('[data-testid="replace-input"]'), plain);
    await settle();
    const dialog = view.container.querySelector('dialog')!;
    expect(dialog.querySelector('input')).toBeNull();
    expect(dialog.textContent).toContain(b.replace.safetyPlain);
    expect(document.activeElement).toBe(button(view, b.replace.cancel));
  });

  test('checking a protected file asks for the password, retries after a wrong one, and says it was protected', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="verify-input"]'), encrypted);
    await settle();
    await type(field(view, b.password.label), 'wrong');
    await submit(view.container.querySelector('[data-testid="password-prompt"]'));
    await until(() => view!.container.textContent!.includes(en.archive.error.wrongPassword));
    expect(view.container.querySelector('[data-testid="file-check-result"]')).toBeNull();
    expect(view.container.textContent).toContain(en.archive.error.wrongPassword);

    await type(field(view, b.password.label), PASSWORD);
    await submit(view.container.querySelector('[data-testid="password-prompt"]'));
    await until(() => view!.container.querySelector('[data-testid="file-check-result"]') !== null);
    expect(view.container.querySelector('[data-testid="password-prompt"]')).toBeNull();
    const box = view.container.querySelector('[data-testid="file-check-result"]')!;
    expect(box.textContent).toContain(b.file.okTitle);
    expect(box.textContent).toContain(b.file.encryptedOk);
  });
});
