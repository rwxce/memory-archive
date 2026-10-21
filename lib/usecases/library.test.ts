import { describe, expect, test, vi } from 'vitest';
import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import { createConversation } from '../db/queries';
import { archiveProfile, createProfile } from './profiles';
import { LibraryOpenTimeout, libraryProblemOf, getPersonDetails, listPeople, openLibrary, openWithTimeout, type Library } from './library';
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
