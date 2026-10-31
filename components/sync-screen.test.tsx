import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { exportArchiveFromLibrary } from '@/lib/usecases/archive-backup';
import { confirmChangesPackDelivered, exportChangesPack } from '@/lib/usecases/changes-pack-export';
import { getPeerState, recordReceived, recordSent } from '@/lib/usecases/sync-state';
import { setNote } from '@/lib/db/queries';
import { storeSharedFiles } from '@/lib/storage/share-inbox';
import { createMemoryCacheStorage } from '@/lib/storage/test-cache-storage';
import { BEN, idOf, NOW, populated, populatedOther, type Lib } from '@/lib/usecases/test-sync';
import { click, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { SyncScreen } from './sync-screen';

const download = vi.fn<(blob: Blob, fileName: string) => void>();
vi.mock('@/hooks/download-blob', () => ({ downloadBlob: (blob: Blob, fileName: string) => download(blob, fileName) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sync',
}));

const s = en.sync;
const PASSWORD = 'a long phrase to remember';

const button = (v: Rendered, name: string) => [...v.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === name);
const text = (v: Rendered) => v.container.textContent ?? '';
const result = (v: Rendered, id: string) => v.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const radio = (v: Rendered, startsWith: string) =>
  [...v.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((el) => el.closest('label')?.textContent?.startsWith(startsWith));

async function pick(v: Rendered, file: File) {
  const input = result(v, 'sync-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/** Waits for slow work (a password makes the key on purpose slowly) that `settle` cannot tell apart from a quiet screen. */
async function until(condition: () => boolean, what: string, limitMs = 15000) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** What the browser was last handed, as a File the other screen can pick. */
const downloaded = () => {
  const [blob, name] = download.mock.calls.at(-1)!;
  return new File([blob], name);
};

let views: Rendered[] = [];
async function open(lib: Lib): Promise<Rendered> {
  const view = await renderWithLibrary(<SyncScreen />, { lib });
  views.push(view);
  await settle();
  return view;
}

beforeEach(() => {
  download.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const view of views) view.unmount();
  views = [];
});

/** `lib` has met a device, so it can be chosen as the target of a file. */
async function meet(lib: Lib, other: Lib) {
  await recordReceived(lib.deps, await idOf(other), 0, null);
}

describe('SyncScreen: this device and its peers', () => {
  test('shows the short device code and, once a device was met, its last exchange', async () => {
    const lib = await populated();
    const other = await populatedOther();
    const view = await open(lib);
    expect(view.container.querySelector('h1')?.textContent).toBe(s.title);
    expect(view.container.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(result(view, 'sync-device-code')?.textContent).toBe((await idOf(lib)).slice(0, 8));
    expect(text(view)).toContain(s.device.noPeers);
    view.unmount();

    await meet(lib, other);
    const again = await open(lib);
    const peers = result(again, 'sync-peers')!;
    expect(peers.textContent).toContain(`Device ${(await idOf(other)).slice(0, 8)}`);
    expect(peers.textContent).toContain(s.device.sentNever);
    expect(peers.textContent).toContain('Last file received:');
  });
});

describe('SyncScreen: exporting', () => {
  test('a new device gets a full file, marked private, and there is nothing to confirm', async () => {
    const view = await open(await populated());
    expect(text(view)).toContain(s.export.privateNote);
    await click(button(view, s.export.submit));
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toMatch(/^memory-archive-changes-.*\.zip$/);
    const box = result(view, 'sync-export-result')!;
    expect(box.textContent).toContain(s.export.savedPrivate);
    expect(box.textContent).toContain(s.export.savedFull);
    expect(box.textContent).toContain('Check your Downloads folder');
    expect(box.textContent).toContain(s.export.savedNewDevice);
    expect(box.textContent).not.toContain('Did you hand');
    expect(box.textContent).not.toMatch(/\bsent\b/i);
  });

  test('an empty password is refused and nothing is downloaded', async () => {
    const view = await open(await populated());
    await click(view.container.querySelector('input[type="checkbox"]'));
    await submit(view.container.querySelector('form'));
    expect(download).not.toHaveBeenCalled();
    expect(text(view)).toContain(en.backup.password.empty);
  });

  test('a protected file is marked as such and is not readable without the password', async () => {
    const view = await open(await populated());
    await click(view.container.querySelector('input[type="checkbox"]'));
    const [password, confirm] = [...view.container.querySelectorAll('input[type="password"]')];
    await type(password, PASSWORD);
    await type(confirm, PASSWORD);
    await submit(view.container.querySelector('form'));
    await until(() => download.mock.calls.length > 0, 'the protected file');
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toMatch(/\.mabackup$/);
    expect(result(view, 'sync-export-result')?.textContent).toContain(s.export.savedProtected);
    const head = new Uint8Array(await download.mock.calls[0][0].slice(0, 4).arrayBuffer());
    expect(new TextDecoder().decode(head)).not.toBe('PK\u0003\u0004');
  });

  test('for a known device the delivery is recorded only after the person says they handed the file over', async () => {
    const lib = await populated();
    const other = await populatedOther();
    await meet(lib, other);
    const peerId = await idOf(other);
    const view = await open(lib);
    expect(radio(view, `Device ${peerId.slice(0, 8)}`)?.checked).toBe(true);
    await click(button(view, s.export.submit));
    await settle();
    const box = result(view, 'sync-export-result')!;
    expect(box.textContent).toContain(s.export.savedChanges);
    expect(box.textContent).toContain(`to device ${peerId.slice(0, 8)}?`);

    // Not yet: nothing is recorded, and the next file would hold the same changes.
    await click(button(view, s.export.confirmNo));
    await settle();
    expect(text(view)).toContain(s.export.notHanded);
    expect((await getPeerState(lib.deps, peerId))?.lastSentAt).toBeNull();

    // A second file, and this time yes.
    await click(button(view, s.export.another));
    await click(button(view, s.export.submit));
    await settle();
    expect((await getPeerState(lib.deps, peerId))?.lastSentAt).toBeNull();
    await click(button(view, s.export.confirmYes));
    await settle();
    expect(text(view)).toContain(s.export.handed);
    expect((await getPeerState(lib.deps, peerId))?.lastSentAt).not.toBeNull();
    expect(text(view)).not.toContain(s.device.sentNever);

    // Everything was handed over: now there is nothing new.
    await click(button(view, s.export.another));
    const before = download.mock.calls.length;
    await click(button(view, s.export.submit));
    await settle();
    expect(result(view, 'sync-export-result')?.textContent).toBe(s.export.nothing);
    expect(download.mock.calls.length).toBe(before);
  });

  test('a restored archive refuses to record a file made before the restore, calmly', async () => {
    const lib = await populated();
    const other = await populatedOther();
    await meet(lib, other);
    const view = await open(lib);
    await click(button(view, s.export.submit));
    await settle();
    // The archive is replaced behind the screen: its device id changes.
    lib.opened.db.run('UPDATE device SET id = ?', ['00000000-0000-4000-8000-0000000000aa']);
    await click(button(view, s.export.confirmYes));
    await settle();
    expect(text(view)).toContain(s.export.errorReplaced);
    expect(button(view, s.export.confirmYes)).toBeDefined();
  });
});

describe('SyncScreen: importing', () => {
  test('a file from another device is merged and the result is told in plain words', async () => {
    const a = await populated();
    const b = await populatedOther();
    const viewA = await open(a);
    await click(button(viewA, s.export.submit));
    await settle();
    const file = downloaded();

    const viewB = await open(b);
    await pick(viewB, file);
    const box = result(viewB, 'sync-import-result')!;
    expect(box.textContent).toContain(s.import.resultTitle);
    expect(box.textContent).toContain('3 new messages added.');
    expect(box.textContent).toContain('2 people added or updated.');
    expect(box.textContent).not.toContain(s.import.conflicts.slice(0, 12));
    // The sender is now a known device, with the moment it was received.
    expect(result(viewB, 'sync-peers')?.textContent).toContain(`Device ${(await idOf(a)).slice(0, 8)}`);
    expect(result(viewB, 'sync-peers')?.textContent).toContain('Last file received:');
  });

  test('a protected file asks for its password, keeps the file after a wrong one, and opens with the right one', async () => {
    const a = await populated();
    const b = await populatedOther();
    const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0', password: PASSWORD });
    const viewB = await open(b);
    await pick(viewB, new File([pack.blob], pack.fileName));
    const prompt = result(viewB, 'password-prompt')!;
    expect(prompt.textContent).toContain(s.import.promptTitle);
    expect(prompt.textContent?.replace(pack.fileName, '')).not.toMatch(/backup/i);

    await type(prompt.querySelector('input'), 'not the password');
    await submit(prompt);
    await until(() => !!result(viewB, 'password-prompt')?.textContent?.includes(s.import.wrongPassword), 'the wrong password message');

    await type(result(viewB, 'password-prompt')!.querySelector('input'), PASSWORD);
    await submit(result(viewB, 'password-prompt'));
    await until(() => !!result(viewB, 'sync-import-result'), 'the merge');
    await settle();
    expect(result(viewB, 'sync-import-result')?.textContent).toContain('3 new messages added.');
    expect(result(viewB, 'password-prompt')).toBeNull();
  });

  test.each([
    ['its own file', 'ownPack'],
    ['a file with a hole before it', 'gap'],
    ['a file made for another device', 'wrongDevice'],
  ] as const)('%s is refused calmly, with nothing changed', async (_name, key) => {
    const a = await populated();
    const b = await populatedOther();
    const c = await populatedOther();
    let file: File;
    if (key === 'ownPack') {
      const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0' });
      file = new File([pack.blob], pack.fileName);
    } else if (key === 'wrongDevice') {
      const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0', peerId: await idOf(c) });
      file = new File([pack.blob], pack.fileName);
    } else {
      // A first file is made and never reaches B; B then gets only the second one.
      const first = await exportChangesPack(a.deps, { appVersion: '1.0.0', peerId: await idOf(b) });
      await confirmChangesPackDelivered(a.deps, first);
      setNote(a.opened.db, { target: { kind: 'profile', profileId: BEN }, body: 'later', now: NOW });
      const second = await exportChangesPack(a.deps, { appVersion: '1.0.0', peerId: await idOf(b) });
      expect(second.since).toBeGreaterThan(0);
      file = new File([second.blob], second.fileName);
    }
    const target = key === 'ownPack' ? a : b;
    const view = await open(target);
    await pick(view, file);
    const box = result(view, 'sync-import-result')!;
    expect(box.textContent).toContain(s.import.errorTitle);
    expect(box.textContent).toContain(s.import.error[key]);
    expect(box.textContent).not.toMatch(/\bsent\b/i);
  });

  test('a full backup picked here is pointed to Backup and restore and is not read further', async () => {
    const a = await populated();
    const backup = await exportArchiveFromLibrary(a.deps, { appVersion: '1.0.0' });
    const b = await populatedOther();
    const view = await open(b);
    await pick(view, new File([backup.blob], backup.fileName));
    const box = result(view, 'sync-import-result')!;
    expect(box.textContent).toContain(backup.fileName);
    expect(box.querySelector('a[href="/backup"]')?.textContent).toBe(s.import.isBackupLink);
    expect(b.opened.db.all<{ n: number }>('SELECT count(*) AS n FROM profiles')[0].n).toBe(1);
  });

  test('choosing the same file twice at once merges it once', async () => {
    const a = await populated();
    const b = await populatedOther();
    const viewA = await open(a);
    await click(button(viewA, s.export.submit));
    await settle();
    const file = downloaded();
    const view = await open(b);
    const input = result(view, 'sync-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    const box = result(view, 'sync-import-result')!;
    expect(box.textContent).toContain('3 new messages added.');
    expect(box.textContent).not.toContain('already in the archive');
  });

  test('something that is not a ZIP gets a calm "not a changes file"', async () => {
    const view = await open(await populated());
    await pick(view, new File(['not a zip at all'], 'notes.zip'));
    expect(result(view, 'sync-import-result')?.textContent).toContain(s.import.error.notPack);
  });
});

describe('SyncScreen: the hand-over question', () => {
  async function asked() {
    const lib = await populated();
    const other = await populatedOther();
    await meet(lib, other);
    const peerId = await idOf(other);
    const view = await open(lib);
    await click(button(view, s.export.submit));
    await settle();
    return { lib, peerId, view };
  }

  test('names the file and the device, and blocks making another file (and changing the device) until answered', async () => {
    const { view, peerId } = await asked();
    const file = download.mock.calls[0][1];
    const box = result(view, 'sync-export-result')!;
    expect(box.textContent).toContain(`Did you hand ${file} to device ${peerId.slice(0, 8)}?`);
    expect(button(view, s.export.submit)?.getAttribute('aria-disabled')).toBe('true');
    expect([...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((el) => el.disabled)).toBe(true);
    // A second click, and a typed password with a click, make no second file.
    await click(button(view, s.export.submit));
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    await click(button(view, s.export.confirmNo));
    expect(button(view, s.export.submit)?.getAttribute('aria-disabled')).toBeNull();
  });

  test('a typed password is not lost when making a file is refused', async () => {
    const { view } = await asked();
    await click(view.container.querySelector('input[type="checkbox"]:not(:disabled)'));
    const [password] = [...view.container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    await type(password, PASSWORD);
    await click(button(view, s.export.submit));
    expect(download).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(PASSWORD);
  });

  test('Yes twice and a new file while it is being saved record once and make nothing more', async () => {
    const { lib, peerId, view } = await asked();
    const yes = button(view, s.export.confirmYes);
    await act(async () => {
      yes?.click();
      yes?.click();
      button(view, s.export.submit)?.click();
    });
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(text(view)).toContain(s.export.handed);
    expect((await getPeerState(lib.deps, peerId))?.lastSentAt).not.toBeNull();
  });

  test('says calmly that nothing new was noted when the record moved on meanwhile', async () => {
    const { lib, peerId, view } = await asked();
    const same = await exportChangesPack(lib.deps, { appVersion: '1.0.0', peerId });
    await recordSent(lib.deps, peerId, same.upTo, null);
    await click(button(view, s.export.confirmYes));
    await settle();
    expect(text(view)).toContain(s.export.handedStale);
    expect(text(view)).not.toContain(s.export.handed);
  });
});

describe('SyncScreen: received files', () => {
  async function shareA() {
    const a = await populated();
    const pack = await exportChangesPack(a.deps, { appVersion: '1.0.0' });
    const caches = createMemoryCacheStorage();
    await storeSharedFiles(caches, 'https://x.example/', [
      new File([pack.blob], pack.fileName, { type: 'application/zip' }),
      new File(['hello'], 'notes.zip', { type: 'application/zip' }),
    ]);
    vi.stubGlobal('caches', caches);
    return { caches, pack };
  }
  const inboxKeys = async (caches: CacheStorage) => (await (await caches.open('memory-archive-share-inbox-v1')).keys()).length;

  test('lists a shared changes file (not other files), adds it, and then forgets it', async () => {
    const { caches, pack } = await shareA();
    const view = await open(await populatedOther());
    await until(() => !!result(view, 'sync-inbox'), 'the received file');
    const list = result(view, 'sync-inbox')!;
    expect(list.textContent).toContain(pack.fileName);
    expect(list.textContent).not.toContain('notes.zip');
    await click(list.querySelector('button'));
    await until(() => !!result(view, 'sync-import-result'), 'the merge');
    await settle();
    expect(result(view, 'sync-import-result')?.textContent).toContain('3 new messages added.');
    expect(result(view, 'sync-inbox')).toBeNull();
    expect(await inboxKeys(caches)).toBe(1);
  });

  test('a file that is removed is gone from the list and from this device', async () => {
    const { caches } = await shareA();
    const view = await open(await populatedOther());
    await until(() => !!result(view, 'sync-inbox'), 'the received file');
    await click(result(view, 'sync-inbox')!.querySelectorAll('button')[1]);
    await settle();
    expect(result(view, 'sync-inbox')).toBeNull();
    expect(await inboxKeys(caches)).toBe(1);
  });
});
