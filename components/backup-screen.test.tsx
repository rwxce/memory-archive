import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import { sha256Hex } from '@/lib/domain/sha256';
import { BLOBS_DIRECTORY, type OpfsDirectoryHandle } from '@/lib/storage/opfs-blob-store';
import { exportArchiveFromLibrary } from '@/lib/usecases/archive-backup';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, type Rendered } from './test-utils';
import { announceStep } from './backup-check-cards';
import { BackupScreen } from './backup-screen';
import { shouldDeliverProgress } from '@/hooks/use-archive-checks';

const download = vi.fn();
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
const PHOTO = new Uint8Array(3000).map((_, i) => (i * 7) % 251);
const PROFILE = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const CONVERSATION = '4f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const BATCH = '5f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

/** A library with one person, one conversation, three messages and one stored photo (synthetic). */
async function seeded(): Promise<Lib & { sha: string }> {
  const lib = await createTestLibrary();
  const db = lib.opened.db;
  const photo = await lib.deps.blobStore.put(PHOTO);
  db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [photo.sha256, photo.size]);
  db.run("INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, 'Ana', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [PROFILE]);
  db.run("INSERT INTO conversations (id, title, source, created_at) VALUES (?, 'Chat', 'whatsapp', '2026-01-01T00:00:00Z')", [CONVERSATION]);
  db.run("INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, 'whatsapp', '2026-01-01T00:00:00Z')", [BATCH, CONVERSATION]);
  for (let n = 1; n <= 3; n++) {
    db.run(
      `INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, ordinal, type, media_sha256) VALUES (?, ?, ?, '2026-01-01T10:00:00', ?, ?, ?)`,
      [CONVERSATION, BATCH, n.toString(16).padStart(64, '0'), n, n === 1 ? 'photo' : 'text', n === 1 ? photo.sha256 : null],
    );
  }
  return Object.assign(lib, { sha: photo.sha256 });
}

async function overwrite(root: OpfsDirectoryHandle, sha: string, bytes: Uint8Array): Promise<void> {
  const shard = await (await root.getDirectoryHandle(BLOBS_DIRECTORY)).getDirectoryHandle(sha.slice(0, 2));
  const file = await shard.getFileHandle(sha);
  if (file.createWritable) {
    const writable = await file.createWritable();
    await writable.write(bytes);
    await writable.close();
  } else {
    const handle = await file.createSyncAccessHandle!();
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.close();
  }
}

const button = (v: Rendered, name: string) => [...v.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === name);
const pick = async (input: Element | null, file: File) => {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const result = (v: Rendered, id: string) => v.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

let view: Rendered | undefined;
beforeEach(() => {
  download.mockClear();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('BackupScreen', () => {
  test('shows counts and bytes per kind, with a link back to Settings', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe(b.title);
    expect(view.container.querySelector('a[href="/settings"]')).not.toBeNull();
    const counts = view.container.querySelector('[data-testid="backup-counts"]')!.textContent!;
    expect(counts).toContain('1 person');
    expect(counts).toContain('3 messages');
    expect(counts).toContain('1 photo, video or audio file');
    const bytes = view.container.querySelector('[data-testid="backup-bytes"]')!.textContent!;
    expect(bytes).toContain(b.usage.media);
    expect(bytes).toContain('3 kB');
  });

  test('a backup is built and handed to the browser; the status says so', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await click(button(view, b.copy.backup));
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toMatch(/\.zip$/);
    expect(view.container.textContent).toContain(en.archive.done.backup);
  });

  test('opening a backup is offered on an empty archive and explained when the archive is not empty', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    expect(view.container.querySelector('[data-testid="restore-input"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="restore-not-empty"]')).toBeNull();
    view.unmount();

    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    expect(view.container.querySelector('[data-testid="restore-input"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="restore-not-empty"]')!.textContent).toBe(b.copy.restoreNotEmpty);
  });

  test('restoring a backup into an empty archive fills it and updates the counts', async () => {
    const source = await seeded();
    const { blob } = await exportArchiveFromLibrary(source.deps, { appVersion: '1.0.0' });
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="restore-input"]'), new File([blob], 'backup.zip'));
    await settle();
    expect(view.container.textContent).toContain(en.archive.done.restore);
    expect(view.container.querySelector('[data-testid="backup-counts"]')!.textContent).toContain('3 messages');
    expect(view.container.querySelector('[data-testid="restore-not-empty"]')).not.toBeNull();
  });

  test('checking the archive: all files in place', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded() });
    await settle();
    await click(button(view, b.check.run));
    await settle();
    const box = result(view, 'library-check-result')!;
    expect(box.textContent).toContain(b.check.okTitle);
    expect(box.textContent).toContain('1 file was checked and it is complete.');
    expect(document.activeElement).toBe(box);
    expect(button(view, b.check.again)).toBeDefined();
  });

  test('checking the archive: a corrupted and a missing file are counted by kind, with no file names or hashes', async () => {
    const lib = await seeded();
    const other = await lib.deps.blobStore.put(new Uint8Array(500).fill(9));
    lib.opened.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [other.sha256, other.size]);
    const flipped = PHOTO.slice();
    flipped[0] ^= 0xff;
    await overwrite(lib.root, lib.sha, flipped);
    await lib.deps.blobStore.delete(other.sha256);
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    await click(button(view, b.check.run));
    await settle();
    const box = result(view, 'library-check-result')!;
    expect(box.textContent).toContain(b.check.problemTitle);
    expect(box.textContent).toContain('2 problems found.');
    expect(box.textContent).toContain('1 file is missing');
    expect(box.textContent).toContain('1 file has changed or is damaged');
    expect(box.textContent).not.toContain(lib.sha.slice(0, 8));
    expect(document.activeElement).toBe(box);
  });

  test('a running check shows a progress bar and can be stopped', async () => {
    const lib = await seeded();
    // Hold the first file open so the check is still running when Stop is pressed.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = lib.deps.blobStore.size.bind(lib.deps.blobStore);
    lib.deps.blobStore.size = async (sha) => {
      await gate;
      return original(sha);
    };
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    await click(button(view, b.check.run));
    const bar = view.container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    await click(button(view, b.check.cancel));
    release();
    await settle();
    expect(result(view, 'library-check-result')!.textContent).toBe(b.check.cancelled);
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
  });

  test('checking a backup file: a good one is complete and says when it was made', async () => {
    const source = await seeded();
    const { blob } = await exportArchiveFromLibrary(source.deps, { appVersion: '1.2.3', now: new Date('2026-05-06T12:00:00Z') });
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    await pick(view.container.querySelector('[data-testid="verify-input"]'), new File([blob], 'backup.zip'));
    await settle();
    const box = result(view, 'file-check-result')!;
    expect(box.textContent).toContain(b.file.okTitle);
    expect(box.textContent).toContain('Memory Archive 1.2.3');
    expect(document.activeElement).toBe(box);
  });

  test('checking a backup file: a file that is not a backup is refused calmly, and a damaged one is reported', async () => {
    const source = await seeded();
    const { blob } = await exportArchiveFromLibrary(source.deps, { appVersion: '1.2.3' });
    view = await renderWithLibrary(<BackupScreen />, { lib: await createTestLibrary() });
    await settle();
    const input = view.container.querySelector('[data-testid="verify-input"]');
    await pick(input, new File([new Uint8Array(100).fill(1)], 'notes.zip'));
    await settle();
    expect(result(view, 'file-check-result')!.textContent).toContain(b.file.refusal.notArchive);

    // Flip one byte inside the stored photo (the ZIP keeps media uncompressed): the scan goes on and reports it.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const at = findSubarray(bytes, PHOTO.slice(0, 64));
    expect(at).toBeGreaterThan(0);
    bytes[at + 10] ^= 0xff;
    await pick(input, new File([bytes], 'backup.zip'));
    await settle();
    const box = result(view, 'file-check-result')!;
    expect(box.textContent).toContain(b.file.problemTitle);
    expect(box.textContent).toContain('1 part has changed or is damaged');
    expect(box.textContent).not.toContain(sha256Hex(PHOTO).slice(0, 8));
  });

  test('is available in Catalan with the same structure', async () => {
    view = await renderWithLibrary(<BackupScreen />, { lib: await seeded(), messages: ca });
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe(ca.backup.title);
    expect(button(view, ca.backup.check.run)).toBeDefined();
  });
});

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe('progress and focus rules', () => {
  test('progress reaches the screen at most every 100 ms or whole percent; the first and the last always do', () => {
    expect(shouldDeliverProgress(undefined, 0, 0)).toBe(true);
    const prev = { at: 1000, percent: 10 };
    expect(shouldDeliverProgress(prev, 0.101, 1010)).toBe(false);
    expect(shouldDeliverProgress(prev, 0.11, 1010)).toBe(true); // a whole percent further
    expect(shouldDeliverProgress(prev, 0.101, 1100)).toBe(true); // 100 ms later
    expect(shouldDeliverProgress(prev, 1, 1001)).toBe(true); // the final one
    expect(shouldDeliverProgress({ at: 1000, percent: -1 }, undefined, 1050)).toBe(false);
  });

  test('screen readers hear progress in quarters only', () => {
    expect([0, 10, 24, 25, 49, 74, 99, 100].map(announceStep)).toEqual([0, 0, 0, 25, 25, 50, 75, 100]);
    expect(announceStep(undefined)).toBeUndefined();
  });

  test('the result does not take focus from something else the person chose meanwhile', async () => {
    const lib = await seeded();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = lib.deps.blobStore.size.bind(lib.deps.blobStore);
    lib.deps.blobStore.size = async (sha) => {
      await gate;
      return original(sha);
    };
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    await click(button(view, b.check.run));
    const other = button(view, b.copy.backup)!;
    other.focus();
    release();
    await settle();
    expect(result(view, 'library-check-result')).not.toBeNull();
    expect(document.activeElement).toBe(other);
  });

  test('when the usage cannot be read, opening a backup is still allowed (restore itself refuses a full library)', async () => {
    const lib = await seeded();
    const call = lib.deps.client.call.bind(lib.deps.client);
    lib.deps.client.call = ((op: string, ...rest: unknown[]) => (op === 'getLibraryStats' ? Promise.reject(new Error('x')) : (call as (...a: unknown[]) => unknown)(op, ...rest))) as typeof lib.deps.client.call;
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    expect(view.container.textContent).toContain(b.usage.failed);
    const pickButton = button(view, b.copy.restore)!;
    expect(pickButton.getAttribute('aria-disabled')).toBeNull();
    expect(view.container.querySelector('[data-testid="restore-input"]')).not.toBeNull();
  });

  test('the not-empty note follows the library\'s own emptiness test (any table with a row)', async () => {
    const lib = await createTestLibrary();
    // Only a profile: no conversation, no message. The old count-based guess said "empty"; the library does not.
    lib.opened.db.run("INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, 'Ana', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [PROFILE]);
    view = await renderWithLibrary(<BackupScreen />, { lib });
    await settle();
    expect(view.container.querySelector('[data-testid="restore-not-empty"]')).not.toBeNull();
  });
});
