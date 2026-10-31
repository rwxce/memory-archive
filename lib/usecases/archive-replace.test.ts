import { zipSync, strToU8 } from 'fflate';
import { describe, expect, test } from 'vitest';
import { DbError } from '../db/errors';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../db/migrations';
import { createProfile, importMessages } from '../db/queries';
import { serializeDb } from '../db/snapshot';
import { wrapOo1Db } from '../db/sql';
import { APP_NAME } from '../exporters/archive/format';
import { writeArchive } from '../exporters/archive/write';
import { buildSearchIndex, searchMessages } from './search';
import { exportArchiveFromLibrary, replaceLibraryFromBackup, restoreArchiveFromZip } from './archive-backup';
import type { ReplaceProgress } from './archive-core';
import { webpBlob } from '../storage/test-thumbnail';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

const ANA = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const BEN = '4a2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5c';
const NOW = '2026-01-01T00:00:00Z';

/** A library with one profile and one media file. */
async function populated(profileId: string, name: string, seed: number): Promise<Lib & { sha256: string }> {
  const lib = await createTestLibrary();
  createProfile(lib.opened.db, { id: profileId, displayName: name, now: NOW });
  const { sha256, size } = await lib.deps.blobStore.put(new Uint8Array(600).map((_, i) => (i * seed) % 251));
  lib.opened.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
  return { ...lib, sha256 };
}

const names = (lib: Lib) => lib.opened.db.all<{ display_name: string }>('SELECT display_name FROM profiles ORDER BY display_name').map((r) => r.display_name);
const hashes = (lib: Lib) => lib.opened.db.all<{ sha256: string }>('SELECT sha256 FROM blobs').map((r) => r.sha256);
const backupOf = async (lib: Lib) => (await exportArchiveFromLibrary(lib.deps, { appVersion: '1' })).blob;
const options = (extra: Partial<Parameters<typeof replaceLibraryFromBackup>[2]> = {}) => ({
  appVersion: '1',
  now: new Date('2026-05-06T00:00:00Z'),
  deliverSafetyBackup: async () => {},
  ...extra,
});

describe('replaceLibraryFromBackup', () => {
  test('replaces a non-empty library: only the backup remains, the safety backup came first and restores', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const backup = await backupOf(source);
    const target = await populated(ANA, 'Ana', 3);
    await target.deps.thumbStore?.put(target.sha256, 320, webpBlob(64));
    expect((await target.deps.thumbStore?.usage())?.count).toBe(1);
    const events: string[] = [];
    let safety: Blob | undefined;
    const progress: ReplaceProgress[] = [];
    const result = await replaceLibraryFromBackup(
      target.deps,
      backup,
      options({
        onProgress: (p) => progress.push(p),
        deliverSafetyBackup: async (blob, fileName) => {
          // Nothing of the old library is touched yet when the person gets the safety backup.
          events.push(`deliver ${fileName} ${names(target).join()}`);
          safety = blob;
        },
      }),
    );
    expect(events).toEqual(['deliver memory-archive-2026-05-06.zip Ana']);
    expect(result).toMatchObject({ safetyBackupFileName: 'memory-archive-2026-05-06.zip', blobCount: 1, leftoverBlobs: 0 });
    expect(names(target)).toEqual(['Ben']);
    expect(hashes(target)).toEqual([source.sha256]);
    expect(await target.deps.blobStore.list()).toEqual([source.sha256]);
    expect(await target.deps.blobStore.verify(source.sha256)).toBe('ok');
    expect((await target.deps.thumbStore?.usage())?.count ?? 0).toBe(0);
    expect(progress.some((p) => p.stage === 'safety-backup')).toBe(true);
    expect(progress.at(-1)).toEqual({ stage: 'restoring', progress: { phase: 'finishing' } });

    // The safety backup is a real backup of the old library.
    const restoredOld = await createTestLibrary();
    await restoreArchiveFromZip(restoredOld.deps, safety!);
    expect(names(restoredOld)).toEqual(['Ana']);
    expect(await restoredOld.deps.blobStore.list()).toEqual([target.sha256]);
  });

  test('an empty library skips the safety backup', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await createTestLibrary();
    const deliver = async () => {
      throw new Error('must not be called');
    };
    const result = await replaceLibraryFromBackup(target.deps, await backupOf(source), options({ deliverSafetyBackup: deliver }));
    expect(result.safetyBackupFileName).toBeUndefined();
    expect(names(target)).toEqual(['Ben']);
  });

  test('media in both libraries is kept once', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 7); // same bytes, same hash
    expect(target.sha256).toBe(source.sha256);
    await replaceLibraryFromBackup(target.deps, await backupOf(source), options());
    expect(await target.deps.blobStore.list()).toEqual([source.sha256]);
    expect(await target.deps.blobStore.verify(source.sha256)).toBe('ok');
  });

  test('a damaged backup is refused and the library is untouched, no safety backup made', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    let delivered = 0;
    const deliver = async () => void delivered++;
    const notZip = replaceLibraryFromBackup(target.deps, new Blob(['nope']), options({ deliverSafetyBackup: deliver }));
    await expect(notZip).rejects.toMatchObject({ name: 'ArchiveError', code: 'not-an-archive' });

    // Same size, flipped byte inside a file the manifest hashes.
    const bytes = new Uint8Array(await (await backupOf(source)).arrayBuffer());
    const at = bytes.findIndex((_, i) => i > 100 && bytes[i] !== 0);
    const corrupt = bytes.slice();
    corrupt[at] ^= 0xff;
    const files = { 'manifest.json': strToU8('{}') };
    await expect(replaceLibraryFromBackup(target.deps, new Blob([zipSync(files)]), options({ deliverSafetyBackup: deliver }))).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
    await expect(replaceLibraryFromBackup(target.deps, new Blob([corrupt]), options({ deliverSafetyBackup: deliver }))).rejects.toMatchObject({
      name: 'ArchiveError',
    });
    expect(delivered).toBe(0);
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
  });

  test('a safety backup that cannot be delivered aborts and changes nothing', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    const failing = options({
      deliverSafetyBackup: async () => {
        throw new Error('QuotaExceededError');
      },
    });
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), failing)).rejects.toMatchObject({ code: 'safety-backup-failed' });
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
  });

  test('a library that cannot be backed up (missing media) aborts with safety-backup-failed', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    await target.deps.blobStore.delete(target.sha256);
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), options())).rejects.toMatchObject({ code: 'safety-backup-failed' });
    expect(names(target)).toEqual(['Ana']);
  });

  test('a failure while storing the backup leaves the old library whole', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const backup = await backupOf(source);
    const target = await populated(ANA, 'Ana', 3);
    const put = target.deps.blobStore.put.bind(target.deps.blobStore);
    target.deps.blobStore.put = async () => {
      throw new Error('disk full');
    };
    await expect(replaceLibraryFromBackup(target.deps, backup, options())).rejects.toMatchObject({ code: 'storage' });
    target.deps.blobStore.put = put;
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
    expect(await target.deps.blobStore.verify(target.sha256)).toBe('ok');
    // The guard was released: a retry works.
    await replaceLibraryFromBackup(target.deps, backup, options());
    expect(names(target)).toEqual(['Ben']);
  });

  test('a database that cannot be loaded rolls back: old rows stay, new media are removed', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    const real = target.deps.client.call.bind(target.deps.client);
    // Fail inside the worker op, after the media are stored.
    (target.deps.client as { call: unknown }).call = (op: string, params: unknown) =>
      op === 'restoreDatabase' ? Promise.reject(new DbError('invalid', 'boom')) : (real as (o: string, p: unknown) => Promise<unknown>)(op, params);
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), options())).rejects.toMatchObject({ name: 'ArchiveError' });
    (target.deps.client as { call: unknown }).call = real;
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
  });

  test('an abort before the swap changes nothing and rejects with the reason', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    const controller = new AbortController();
    const abortAfterSafety = options({
      signal: controller.signal,
      deliverSafetyBackup: async () => controller.abort(new Error('stop')),
    });
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), abortAfterSafety)).rejects.toThrow('stop');
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
    // Already aborted: refused before anything happens.
    const stopped = new AbortController();
    stopped.abort(new Error('early'));
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), options({ signal: stopped.signal }))).rejects.toThrow('early');
  });

  test('a second replace while one runs is busy', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const backup = await backupOf(source);
    const target = await populated(ANA, 'Ana', 3);
    const first = replaceLibraryFromBackup(target.deps, backup, options());
    await expect(replaceLibraryFromBackup(target.deps, backup, options())).rejects.toMatchObject({ code: 'busy' });
    await first;
    expect(names(target)).toEqual(['Ben']);
  });
});

/** A backup whose manifest and hashes are all valid around the given database bytes. */
const backupAround = (
  database: Uint8Array,
  schemaVersion: number,
  blobs: { sha256: string; size: number }[] = [],
  open: (sha256: string) => Promise<ReadableStream<Uint8Array> | undefined> = async () => undefined,
) => writeArchive({ app: { name: APP_NAME, version: '1' }, createdAt: new Date('2026-04-01T00:00:00Z'), schemaVersion, database, blobs, openBlob: open });

async function bareDb(migrations: Parameters<typeof migrate>[1]) {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3.capi);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, migrations);
  return db;
}

describe('replaceLibraryFromBackup: hostile and edge cases', () => {
  test('an abort noticed right before the swap rejects with the signal reason, not invalid-database, and cleans up', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const backup = await backupOf(source);
    const target = await populated(ANA, 'Ana', 3);
    const controller = new AbortController();
    const reason = new Error('stop at the swap');
    const error = await replaceLibraryFromBackup(
      target.deps,
      backup,
      // After the last media file, the next check is the one right before the swap.
      options({
        signal: controller.signal,
        onProgress: (p) => p.stage === 'restoring' && p.progress.phase === 'media' && p.progress.done === p.progress.total && controller.abort(reason),
      }),
    ).then(() => undefined, (e: unknown) => e);
    expect(error).toBe(reason);
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
  });

  test('a backup with a bad database but valid hashes is refused before the safety backup and before any media is stored', async () => {
    const source = await populated(BEN, 'Ben', 7);
    source.opened.db.exec('CREATE TRIGGER t AFTER INSERT ON profiles BEGIN SELECT 1; END');
    const backup = await backupAround(serializeDb(source.opened.db), SCHEMA_VERSION, [{ sha256: source.sha256, size: 600 }], (h) => source.deps.blobStore.open(h));
    const target = await populated(ANA, 'Ana', 3);
    let delivered = 0;
    await expect(replaceLibraryFromBackup(target.deps, backup, options({ deliverSafetyBackup: async () => void delivered++ }))).rejects.toMatchObject({
      name: 'ArchiveError',
      code: 'invalid-database',
    });
    expect(delivered).toBe(0);
    expect(names(target)).toEqual(['Ana']);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);

    // Media references that disagree with the archive contents are caught the same way.
    const mismatched = await populated(BEN, 'Ben', 9);
    const lying = await backupAround(serializeDb(mismatched.opened.db), SCHEMA_VERSION);
    await expect(replaceLibraryFromBackup(target.deps, lying, options({ deliverSafetyBackup: async () => void delivered++ }))).rejects.toMatchObject({
      code: 'invalid-database',
    });
    expect(delivered).toBe(0);
  });

  test('a backup from a newer schema is refused; one from an older schema is migrated', async () => {
    const target = await populated(ANA, 'Ana', 3);
    const newer = await backupAround(serializeDb(await bareDb(MIGRATIONS)), SCHEMA_VERSION + 1);
    await expect(replaceLibraryFromBackup(target.deps, newer, options())).rejects.toMatchObject({ code: 'newer-schema' });
    expect(names(target)).toEqual(['Ana']);

    const old = await bareDb(MIGRATIONS.slice(0, 6));
    old.run('INSERT INTO profiles (id, display_name, relationship, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [BEN, 'Ben', 'friend', NOW, NOW]);
    const result = await replaceLibraryFromBackup(target.deps, await backupAround(serializeDb(old), 6), options());
    expect(result.blobCount).toBe(0);
    expect(names(target)).toEqual(['Ben']);
    expect(target.opened.db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(await target.deps.blobStore.list()).toEqual([]);
  });

  test('a write between the safety backup and the swap aborts with changed-during-replace and loses nothing', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const backup = await backupOf(source);
    const target = await populated(ANA, 'Ana', 3);
    await expect(
      replaceLibraryFromBackup(
        target.deps,
        backup,
        // A profile edit does not take the archive guard: it can land while the person saves the safety copy.
        options({ deliverSafetyBackup: async () => void target.opened.db.run("UPDATE profiles SET description = 'edited meanwhile'") }),
      ),
    ).rejects.toMatchObject({ name: 'ArchiveError', code: 'changed-during-replace' });
    expect(target.opened.db.all('SELECT display_name, description FROM profiles')).toEqual([{ display_name: 'Ana', description: 'edited meanwhile' }]);
    expect(await target.deps.blobStore.list()).toEqual([target.sha256]);
    // Nothing is stuck: trying again (with no edit in between) works.
    await replaceLibraryFromBackup(target.deps, backup, options());
    expect(names(target)).toEqual(['Ben']);
  });

  test('a write into an empty library before the swap is also refused', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await createTestLibrary();
    const real = target.deps.client.call.bind(target.deps.client);
    (target.deps.client as { call: unknown }).call = (op: string, params: unknown) => {
      if (op === 'restoreDatabase') createProfile(target.opened.db, { id: ANA, displayName: 'Ana', now: NOW });
      return (real as (o: string, p: unknown) => Promise<unknown>)(op, params);
    };
    await expect(replaceLibraryFromBackup(target.deps, await backupOf(source), options())).rejects.toMatchObject({ code: 'changed-during-replace' });
    expect(names(target)).toEqual(['Ana']);
  });

  test('if the worker dies before answering the swap, the media it may reference are kept and reported', async () => {
    const source = await populated(BEN, 'Ben', 7);
    const target = await populated(ANA, 'Ana', 3);
    const real = target.deps.client.call.bind(target.deps.client);
    (target.deps.client as { call: unknown }).call = (op: string, params: unknown) =>
      op === 'restoreDatabase' ? Promise.reject(new Error('worker went away')) : (real as (o: string, p: unknown) => Promise<unknown>)(op, params);
    const error = await replaceLibraryFromBackup(target.deps, await backupOf(source), options()).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ name: 'ArchiveError', leftoverBlobs: 1 });
    // The new file stays (a swap that did commit would point at it); so does the old one.
    expect((await target.deps.blobStore.list()).sort()).toEqual([source.sha256, target.sha256].sort());
  });

  test('the search index starts over after a replace: the new messages are found, the old ones are gone', async () => {
    const add = (lib: Lib, conversationId: string, body: string, key: string) =>
      importMessages(lib.opened.db, {
        batchId: conversationId,
        conversationId,
        source: 'whatsapp',
        sourceLabel: 'x',
        now: NOW,
        blobs: [],
        messages: [
          { fingerprint: key.padEnd(64, 'f'), sentAt: '2026-01-01T10:00:00', ordinal: 0, type: 'text', participantName: 'Ana', body, mediaSha256: null, mediaName: '' },
        ],
        newConversation: { title: 'Chat', sourceKey: body, isGroup: false, profileIds: [] },
      });
    const source = await createTestLibrary();
    add(source, '00000000-0000-4000-8000-0000000000a1', 'vam anar a la platja', '1');
    const target = await createTestLibrary();
    add(target, '00000000-0000-4000-8000-0000000000a2', 'dinar a barcelona', '2');
    await buildSearchIndex(target.deps);
    expect(await searchMessages(target.deps, undefined, 'barcelona', 0)).toHaveLength(1);

    await replaceLibraryFromBackup(target.deps, await backupOf(source), options());
    expect(await searchMessages(target.deps, undefined, 'barcelona', 0)).toHaveLength(0);
    expect(await searchMessages(target.deps, undefined, 'platja', 0)).toHaveLength(1);
  });
});
