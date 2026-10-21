import { describe, expect, test, vi } from 'vitest';
import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import { createConversation } from '../db/queries';
import { archiveProfile, createProfile } from './profiles';
import { LibraryOpenTimeout, libraryProblemOf, listPeople, openLibrary, openWithTimeout, type Library } from './library';
import { createTestLibrary } from './test-client';

function fakeClient(call: DbClient['call']) {
  const close = vi.fn<() => void>();
  return { client: { call, close } as DbClient, close };
}

describe('openLibrary', () => {
  test('checks the database, opens the file store and hands back usable deps', async () => {
    const lib = await createTestLibrary();
    const createClient = vi.fn(() => lib.client);
    const result = await openLibrary({ workerUrl: '/db/worker.js', createClient, openBlobStore: async () => lib.deps.blobStore });
    expect(createClient).toHaveBeenCalledWith('/db/worker.js');
    expect(result.deps.client).toBe(lib.client);
    expect(await listPeople(result.deps)).toEqual({ active: [], archived: [] });
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

describe('openWithTimeout', () => {
  const lib = (): Library => ({ deps: {} as Library['deps'], close: vi.fn() });

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
