import { describe, expect, test, vi } from 'vitest';
import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import { createConversation } from '../db/queries';
import { archiveProfile, createProfile } from './profiles';
import { strToU8, zipSync } from 'fflate';
import { importWhatsAppExport } from './import';
import { ARCHIVE_LOCK_NAME, withArchiveGuard, type ArchiveLock } from './archive-guard';
import { LibraryOpenTimeout, importWorkerUrlOf, libraryProblemOf, getPersonDetails, listPeople, openLibrary, openWithTimeout, type Library } from './library';
import { createTestLibrary } from './test-client';

function fakeClient(call: DbClient['call']) {
  const close = vi.fn<() => void>();
  return { client: { call, close, connectPort: () => { throw new Error('unused'); } } as DbClient, close };
}

describe('openLibrary', () => {
  test('checks the database, opens the file store and hands back usable deps', async () => {
    const lib = await createTestLibrary();
    const createClient = vi.fn(() => lib.client);
    const result = await openLibrary({ workerUrl: '/db/worker.js', createClient, openBlobStore: async () => lib.deps.blobStore });
    expect(createClient).toHaveBeenCalledWith('/db/worker.js');
    expect(result.deps.client).toBe(lib.client);
    expect(await listPeople(result.deps)).toEqual({ active: [], archived: [], unassigned: [] });
  });

  test('hands over the thumbnail cache, and a cache that cannot open never fails the open', async () => {
    const lib = await createTestLibrary();
    const withCache = await openLibrary({ workerUrl: '/w.js', createClient: () => lib.client, openBlobStore: async () => lib.deps.blobStore, openThumbStore: async () => lib.deps.thumbStore! });
    expect(withCache.deps.thumbStore).toBe(lib.deps.thumbStore);
    const without = await openLibrary({
      workerUrl: '/w.js',
      createClient: () => lib.client,
      openBlobStore: async () => lib.deps.blobStore,
      openThumbStore: async () => {
        throw new Error('no OPFS');
      },
    });
    expect(without.deps.thumbStore).toBeUndefined();
    expect(without.deps.blobStore).toBe(lib.deps.blobStore);
  });

  test('a database that cannot open rejects with its error and is closed', async () => {
    const { client, close } = fakeClient(async () => {
      throw new DbError('unavailable', 'held by another tab');
    });
    await expect(
      openLibrary({ workerUrl: '/w.js', createClient: () => client, openBlobStore: async () => (await createTestLibrary()).deps.blobStore }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(close).toHaveBeenCalledOnce();
  });

  test('a file store that cannot open counts as unavailable storage and closes the worker', async () => {
    const { client, close } = fakeClient(async () => ({}) as never);
    await expect(
      openLibrary({
        workerUrl: '/w.js',
        createClient: () => client,
        openBlobStore: async () => {
          throw new Error('no OPFS');
        },
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(close).toHaveBeenCalledOnce();
  });
});

/** One holder per name, `ifAvailable` semantics (what `webArchiveLock` does with Web Locks). */
function createLock(): ArchiveLock & { hold(): () => void } {
  const held = new Set<string>();
  const lock = (async (name, work) => {
    if (held.has(name)) return { held: false } as const;
    held.add(name);
    try {
      return { held: true, value: await work() } as const;
    } finally {
      held.delete(name);
    }
  }) as ArchiveLock & { hold(): () => void };
  lock.hold = () => {
    held.add(ARCHIVE_LOCK_NAME);
    return () => held.delete(ARCHIVE_LOCK_NAME);
  };
  return lock;
}

const ORPHAN = new Uint8Array([1, 2, 3, 4]);

async function tmpDirectory(lib: Awaited<ReturnType<typeof createTestLibrary>>) {
  const base = await lib.root.getDirectoryHandle('memory-archive-blobs');
  return base.getDirectoryHandle('tmp');
}

async function tmpNames(lib: Awaited<ReturnType<typeof createTestLibrary>>) {
  const names: string[] = [];
  for await (const [name] of (await tmpDirectory(lib)).entries()) names.push(name);
  return names;
}

describe('openLibrary: wiring for the import', () => {
  test('hands the import worker its URL (next to the database worker unless given) and a port to the connection', async () => {
    expect(importWorkerUrlOf('/db/worker.js')).toBe('/db/import-worker.js');
    expect(importWorkerUrlOf('/base/path/db/worker.js')).toBe('/base/path/db/import-worker.js');
    const lib = await createTestLibrary();
    const open = (extra: object = {}) =>
      openLibrary({ workerUrl: '/app/db/worker.js', createClient: () => lib.client, openBlobStore: async () => lib.deps.blobStore, ...extra });
    expect((await open()).importWorkerUrl).toBe('/app/db/import-worker.js');
    expect((await open({ importWorkerUrl: '/elsewhere/iw.js' })).importWorkerUrl).toBe('/elsewhere/iw.js');
    const port = (await open()).connectPort();
    expect(port).toBeInstanceOf(MessagePort);
    port.close();
  });
});

describe('openLibrary: cleanup at open (temp files and orphan blobs)', () => {
  async function openWith(lib: Awaited<ReturnType<typeof createTestLibrary>>, lock: ArchiveLock | undefined) {
    const opened = await openLibrary({ workerUrl: '/db/worker.js', createClient: () => lib.client, openBlobStore: async () => lib.deps.blobStore, ...(lock ? { lock } : {}) });
    await opened.cleanup;
    return opened;
  }

  async function leftovers(lib: Awaited<ReturnType<typeof createTestLibrary>>) {
    await lib.deps.blobStore.put(ORPHAN);
    await (await tmpDirectory(lib)).getFileHandle('abandoned.tmp', { create: true });
  }

  test('while it holds the lock it removes orphan blobs and abandoned temp files, and keeps referenced blobs', async () => {
    const lib = await createTestLibrary();
    const profile = await createProfile(lib.deps, { displayName: 'Ana' });
    const kept = await lib.deps.blobStore.put(new Uint8Array([9, 9, 9]));
    lib.opened.db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [kept.sha256, kept.size, null]);
    lib.opened.db.run('UPDATE profiles SET photo_sha256 = ? WHERE id = ?', [kept.sha256, profile.id]);
    await leftovers(lib);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
    await openWith(lib, createLock());
    expect(await lib.deps.blobStore.list()).toEqual([kept.sha256]);
    expect(await tmpNames(lib)).toEqual([]);
  });

  test('another tab or an import worker holds the lock: nothing is swept, silently, and the library still opens', async () => {
    const lib = await createTestLibrary();
    await leftovers(lib);
    const lock = createLock();
    const release = lock.hold();
    const opened = await openWith(lib, lock);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(await tmpNames(lib)).toEqual(['abandoned.tmp']);
    expect(await listPeople(opened.deps)).toEqual({ active: [], archived: [], unassigned: [] });
    // The next open, once the holder is gone, cleans up.
    release();
    await openWith(lib, lock);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(await tmpNames(lib)).toEqual([]);
  });

  test('no lock to take (a browser without Web Locks): nothing is swept', async () => {
    const lib = await createTestLibrary();
    await leftovers(lib);
    vi.stubGlobal('navigator', {});
    try {
      await openWith(lib, undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(await tmpNames(lib)).toEqual(['abandoned.tmp']);
  });

  test('an archive operation running in this tab (the in-tab guard) also skips it', async () => {
    const lib = await createTestLibrary();
    await leftovers(lib);
    let finish: () => void = () => {};
    const running = withArchiveGuard(lib.deps.blobStore, () => new Promise<void>((resolve) => (finish = resolve)));
    await openWith(lib, createLock());
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(await tmpNames(lib)).toEqual(['abandoned.tmp']);
    finish();
    await running;
  });

  test('a cleanup that fails does not fail the open (and logs no data)', async () => {
    const lib = await createTestLibrary();
    const client = { ...lib.client, call: (async (op: string, ...args: unknown[]) => {
      if (op === 'listBlobHashes') throw new DbError('internal', 'secret detail');
      return (lib.client.call as (...a: unknown[]) => unknown)(op, ...args);
    }) as DbClient['call'] } as DbClient;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opened = await openLibrary({ workerUrl: '/db/worker.js', createClient: () => client, openBlobStore: async () => lib.deps.blobStore, lock: createLock() });
    expect(opened.deps.client).toBe(client);
    await opened.cleanup;
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
    warn.mockRestore();
  });
});

describe('openLibrary: the cleanup does not hold the open back', () => {
  test('a slow cleanup (slow blob delete) does not count toward the open timeout: the library resolves first, the cleanup finishes later', async () => {
    const lib = await createTestLibrary();
    await lib.deps.blobStore.put(ORPHAN);
    const slowStore = { ...lib.deps.blobStore, delete: async (sha: string) => (await new Promise((r) => setTimeout(r, 150)), lib.deps.blobStore.delete(sha)) };
    const opened = await openWithTimeout(
      () => openLibrary({ workerUrl: '/db/worker.js', createClient: () => lib.client, openBlobStore: async () => slowStore, lock: createLock() }),
      50,
    );
    // Open resolved while the cleanup is still running: it holds the guard, so an import would be busy
    // and a plain close is refused until it ends.
    expect(opened.isBusy()).toBe(true);
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(() => opened.close()).toThrowError(expect.objectContaining({ code: 'busy' }));
    await opened.cleanup;
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(opened.isBusy()).toBe(false);
  });

  test('media of an imported message and a profile photo survive the cleanup; the orphan does not', async () => {
    const lib = await createTestLibrary();
    const profile = await createProfile(lib.deps, { displayName: 'Ana' });
    const photo = await lib.deps.blobStore.put(new Uint8Array([9, 9, 9]));
    lib.opened.db.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [photo.sha256, photo.size, null]);
    lib.opened.db.run('UPDATE profiles SET photo_sha256 = ? WHERE id = ?', [photo.sha256, profile.id]);
    const file = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
    const zip = new Blob([
      zipSync({ '_chat.txt': strToU8(`[17/03/2026, 13:20:00] Ana: <attached: ${file}>`), [file]: new Uint8Array(200).map((_, i) => i % 251) }) as BlobPart,
    ]);
    const result = await importWhatsAppExport(lib.deps, { zip, fileName: 'WhatsApp Chat - Ana.zip', profileIds: [profile.id], meAuthor: null });
    expect(result).toMatchObject({ status: 'imported', summary: { mediaAdded: 1 } });
    const orphan = await lib.deps.blobStore.put(ORPHAN);
    const before = await lib.deps.blobStore.list();
    expect(before).toHaveLength(3);
    const opened = await openLibrary({ workerUrl: '/db/worker.js', createClient: () => lib.client, openBlobStore: async () => lib.deps.blobStore, lock: createLock() });
    await opened.cleanup;
    const after = await lib.deps.blobStore.list();
    expect(after).toEqual(before.filter((sha) => sha !== orphan.sha256));
    expect(after).toContain(photo.sha256);
    expect(after).toHaveLength(2);
  });
});

describe('Library.close while an archive operation runs', () => {
  test('refuses (busy) and closes nothing; `force` closes; idle closes', async () => {
    const lib = await createTestLibrary();
    const close = vi.spyOn(lib.client, 'close');
    const opened = await openLibrary({ workerUrl: '/db/worker.js', createClient: () => lib.client, openBlobStore: async () => lib.deps.blobStore });
    await opened.cleanup;
    expect(opened.isBusy()).toBe(false);
    let finish: () => void = () => {};
    const running = withArchiveGuard(lib.deps.blobStore, () => new Promise<void>((resolve) => (finish = resolve)));
    expect(opened.isBusy()).toBe(true);
    expect(() => opened.close()).toThrowError(expect.objectContaining({ name: 'ArchiveError', code: 'busy' }));
    expect(close).not.toHaveBeenCalled();
    opened.close({ force: true });
    expect(close).toHaveBeenCalledTimes(1);
    finish();
    await running;
    expect(opened.isBusy()).toBe(false);
    opened.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('libraryProblemOf', () => {
  test('maps database errors to reasons the UI can explain', () => {
    expect(libraryProblemOf(new DbError('unavailable', 'x'))).toBe('in-use');
    expect(libraryProblemOf(new DbError('newer-schema', 'x'))).toBe('newer-version');
    expect(libraryProblemOf(new DbError('internal', 'x'))).toBe('other');
    expect(libraryProblemOf('boom')).toBe('other');
  });
});

describe('listPeople', () => {
  test('splits active from archived and counts conversations per person', async () => {
    const { deps, opened } = await createTestLibrary();
    const ana = await createProfile(deps, { displayName: 'Ana' });
    const bo = await createProfile(deps, { displayName: 'Bo' });
    await createProfile(deps, { displayName: 'Cy' });
    const mkConversation = (id: string, profileIds: string[]) =>
      createConversation(opened.db, {
        id,
        title: 'Chat',
        source: 'whatsapp',
        isGroup: profileIds.length > 1,
        profileIds,
        participants: [],
        now: '2026-03-01T10:00:00.000Z',
      });
    mkConversation('00000000-0000-4000-8000-0000000000a1', [ana.id]);
    mkConversation('00000000-0000-4000-8000-0000000000a2', [ana.id, bo.id]);
    await archiveProfile(deps, bo.id);

    const people = await listPeople(deps);
    expect(people.active.map((p) => [p.displayName, p.conversationCount])).toEqual([
      ['Ana', 2],
      ['Cy', 0],
    ]);
    expect(people.archived.map((p) => [p.displayName, p.conversationCount])).toEqual([['Bo', 1]]);
  });
});

describe('listPeople: unassigned conversations', () => {
  test('lists conversations filed under nobody, with participants, and none when every one is filed', async () => {
    const { deps, opened } = await createTestLibrary();
    const ana = await createProfile(deps, { displayName: 'Ana' });
    const make = (id: string, profileIds: string[], isGroup = false) =>
      createConversation(opened.db, { id, title: id.slice(-2), source: 'whatsapp', isGroup, profileIds, participants: [{ displayName: 'Zed', profileId: null }], now: '2026-03-01T10:00:00.000Z' });
    make('00000000-0000-4000-8000-0000000000a1', [ana.id]);
    expect((await listPeople(deps)).unassigned).toEqual([]);
    make('00000000-0000-4000-8000-0000000000a2', [], true);
    const { unassigned } = await listPeople(deps);
    expect(unassigned).toMatchObject([{ title: 'a2', isGroup: true, profileIds: [], participants: ['Zed'] }]);
  });
});

describe('getPersonDetails', () => {
  test('returns the person (archived too), their conversations with participants, and everyone', async () => {
    const { deps, opened } = await createTestLibrary();
    const ana = await createProfile(deps, { displayName: 'Ana' });
    const bo = await createProfile(deps, { displayName: 'Bo' });
    await archiveProfile(deps, bo.id);
    createConversation(opened.db, { id: '00000000-0000-4000-8000-0000000000a1', title: 'Group', source: 'whatsapp', isGroup: true, profileIds: [ana.id, bo.id], participants: [{ displayName: 'Ana', profileId: ana.id }], now: '2026-03-01T10:00:00.000Z' });
    const details = await getPersonDetails(deps, bo.id);
    expect(details?.person).toMatchObject({ displayName: 'Bo', conversationCount: 1 });
    expect(details?.person.archivedAt).not.toBeNull();
    expect(details?.conversations).toMatchObject([{ title: 'Group', participants: ['Ana'], profileIds: [ana.id, bo.id] }]);
    expect(details?.people.active.map((p) => p.displayName)).toEqual(['Ana']);
  });

  test('an unknown, malformed or empty id is undefined, not an error', async () => {
    const { deps } = await createTestLibrary();
    await createProfile(deps, { displayName: 'Ana' });
    for (const id of ['00000000-0000-4000-8000-00000000ffff', 'not-a-uuid', '', "' OR 1=1 --"]) {
      expect(await getPersonDetails(deps, id)).toBeUndefined();
    }
  });

  test('other failures still reject', async () => {
    const { deps } = await createTestLibrary();
    const broken = { ...deps, client: { call: () => Promise.reject(new DbError('internal', 'x')) } as unknown as DbClient };
    await expect(getPersonDetails(broken, '00000000-0000-4000-8000-0000000000a1')).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('openWithTimeout', () => {
  const lib = (): Library => ({ deps: {} as Library['deps'], cleanup: Promise.resolve(), importWorkerUrl: '', connectPort: vi.fn(), isBusy: () => false, close: vi.fn() });

  test('passes an open that finishes in time through', async () => {
    const opened = lib();
    await expect(openWithTimeout(async () => opened, 50)).resolves.toBe(opened);
    expect(opened.close).not.toHaveBeenCalled();
  });

  test('rejects a hung open as unavailable, and closes it if it finishes later', async () => {
    let finish: (l: Library) => void = () => {};
    const result = openWithTimeout(() => new Promise<Library>((resolve) => (finish = resolve)), 10);
    await expect(result).rejects.toBeInstanceOf(LibraryOpenTimeout);
    await expect(result).rejects.toMatchObject({ code: 'unavailable' });
    const late = lib();
    finish(late);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(late.close).toHaveBeenCalledOnce();
  });

  test('passes an open error through unchanged', async () => {
    const error = new DbError('newer-schema', 'x');
    await expect(openWithTimeout(() => Promise.reject(error), 50)).rejects.toBe(error);
  });
});
