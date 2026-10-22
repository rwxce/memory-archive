import { describe, expect, test } from 'vitest';
import { MIGRATIONS, migrate } from '../db/migrations';
import { openMemoryDb } from '../db/open';
import { createProfile } from '../db/queries';
import { isLibraryEmpty } from '../db/snapshot';
import { wrapOo1Db } from '../db/sql';
import { openBlobStore } from '../storage/opfs-blob-store';
import { openThumbStore } from '../storage/opfs-thumb-store';
import { createMemoryDirectory } from '../storage/test-opfs-directory';
import { webpBlob } from '../storage/test-thumbnail';
import { unzipSync } from 'fflate';
import { exportArchive, exportArchiveFromLibrary, restoreArchiveFromZip, restoreArchiveIntoEmptyLibrary, type ArchiveProgress } from './archive';
import { createTestLibrary } from './test-client';

const ID = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';

async function library() {
  const root = createMemoryDirectory();
  return { db: (await openMemoryDb()).db, blobStore: await openBlobStore(root), thumbStore: await openThumbStore(root) };
}

describe('archive use cases', () => {
  test('an empty library exports and restores into another empty library', async () => {
    const a = await library();
    createProfile(a.db, { id: ID, displayName: 'Ana', now: '2026-01-01T00:00:00Z' });
    const { blob, fileName, blobCount } = await exportArchive(a, { appVersion: '1', now: new Date('2026-05-06T00:00:00Z') });
    expect(fileName).toBe('memory-archive-2026-05-06.zip');
    expect(blobCount).toBe(0);
    const b = await library();
    await restoreArchiveIntoEmptyLibrary(b, blob);
    expect(b.db.all('SELECT display_name FROM profiles')).toEqual([{ display_name: 'Ana' }]);
  });

  test('restoring twice is refused the second time', async () => {
    const a = await library();
    const { blob } = await exportArchive(a, { appVersion: '1' });
    const b = await library();
    await restoreArchiveIntoEmptyLibrary(b, blob);
    createProfile(b.db, { id: ID, displayName: 'Ana', now: '2026-01-01T00:00:00Z' });
    expect(isLibraryEmpty(b.db)).toBe(false);
    await expect(restoreArchiveIntoEmptyLibrary(b, blob)).rejects.toMatchObject({ code: 'target-not-empty' });
  });

  test('two restores started together: one runs, the other is busy, media stays intact', async () => {
    const a = await library();
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const { sha256, size } = await a.blobStore.put(bytes);
    a.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
    const { blob } = await exportArchive(a, { appVersion: '1' });
    const b = await library();
    const results = await Promise.allSettled([restoreArchiveIntoEmptyLibrary(b, blob), restoreArchiveIntoEmptyLibrary(b, blob)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'busy' });
    expect(await b.blobStore.list()).toEqual([sha256]);
    expect(await b.blobStore.verify(sha256)).toBe('ok');
    expect(b.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256 }]);
  });

  test('an export during a restore is busy, and the guard is released afterwards', async () => {
    const a = await library();
    const { blob } = await exportArchive(a, { appVersion: '1' });
    const b = await library();
    const restoring = restoreArchiveIntoEmptyLibrary(b, blob);
    await expect(exportArchive(b, { appVersion: '1' })).rejects.toMatchObject({ code: 'busy' });
    await restoring;
    await expect(exportArchive(b, { appVersion: '1' })).resolves.toMatchObject({ blobCount: 0 });
  });

  test('the guard is released after a failure', async () => {
    const b = await library();
    await expect(restoreArchiveIntoEmptyLibrary(b, new Blob(['nope']))).rejects.toMatchObject({ code: 'not-an-archive' });
    await expect(restoreArchiveIntoEmptyLibrary(b, new Blob(['nope']))).rejects.toMatchObject({ code: 'not-an-archive' });
  });

  test('an archive written by schema v2 restores into the current schema', async () => {
    const { default: init } = await import('@sqlite.org/sqlite-wasm');
    const sqlite3 = await init();
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3.capi);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 2));
    const old = { db, blobStore: await openBlobStore(createMemoryDirectory()) };
    const { sha256, size } = await old.blobStore.put(new Uint8Array(64).fill(3));
    db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
    db.run('INSERT INTO profiles (id, display_name, photo_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [ID, 'Ana', sha256, 't', 't']);
    const { blob } = await exportArchive(old, { appVersion: '1' });
    const target = await library();
    const result = await restoreArchiveIntoEmptyLibrary(target, blob);
    expect(result).toMatchObject({ blobCount: 1, manifest: { schemaVersion: 2 } });
    expect(target.db.all('SELECT display_name, photo_sha256 FROM profiles')).toEqual([{ display_name: 'Ana', photo_sha256: sha256 }]);
    expect(target.db.all('PRAGMA user_version')).toEqual([{ user_version: MIGRATIONS.length }]);
    expect(await target.blobStore.list()).toEqual([sha256]);
  });

  test('thumbnails are a local cache: not in the exported ZIP, and a restore works from an empty cache and clears a stale one', async () => {
    const a = await library();
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const { sha256, size } = await a.blobStore.put(bytes);
    a.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
    await a.thumbStore.put(sha256, 320, webpBlob(60));
    const withCache = await exportArchive(a, { appVersion: '1', now: new Date('2026-05-06T00:00:00Z') });
    const files = Object.keys(unzipSync(new Uint8Array(await withCache.blob.arrayBuffer())));
    // exactly the known layout: manifest, database, and the one blob
    expect([...files].sort()).toEqual(['blobs/' + sha256.slice(0, 2) + '/' + sha256, 'db/library.sqlite', 'manifest.json']);
    // the same archive with an empty cache has the same entries
    await a.thumbStore.clear();
    const without = await exportArchive(a, { appVersion: '1', now: new Date('2026-05-06T00:00:00Z') });
    expect(Object.keys(unzipSync(new Uint8Array(await without.blob.arrayBuffer()))).sort()).toEqual(files.sort());

    const b = await library();
    await b.thumbStore.put('f'.repeat(64), 320, webpBlob(60)); // left over from earlier use of this device
    await restoreArchiveIntoEmptyLibrary(b, withCache.blob);
    expect(await b.blobStore.list()).toEqual([sha256]);
    expect(await b.thumbStore.usage()).toEqual({ count: 0, bytes: 0 });
  });
});

describe('archive use cases through the database client (the PWA path)', () => {
  async function withMedia() {
    const lib = await createTestLibrary();
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 251);
    const { sha256, size } = await lib.deps.blobStore.put(bytes);
    await lib.client.call('createProfile', { id: ID, displayName: 'Ana', now: '2026-01-01T00:00:00Z' });
    lib.opened.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
    return { lib, sha256 };
  }

  test('export then restore into an empty library round-trips data and media, reporting progress', async () => {
    const { lib: a, sha256 } = await withMedia();
    const exported: ArchiveProgress[] = [];
    const { blob, fileName, blobCount } = await exportArchiveFromLibrary(a.deps, {
      appVersion: '1',
      now: new Date('2026-05-06T00:00:00Z'),
      onProgress: (p) => exported.push(p),
    });
    expect(fileName).toBe('memory-archive-2026-05-06.zip');
    expect(blobCount).toBe(1);
    expect(exported).toEqual([{ phase: 'preparing' }, { phase: 'media', done: 1, total: 1 }, { phase: 'finishing' }]);

    const b = await createTestLibrary();
    const restored: ArchiveProgress[] = [];
    const result = await restoreArchiveFromZip(b.deps, blob, { onProgress: (p) => restored.push(p) });
    expect(result.blobCount).toBe(1);
    expect(restored).toEqual([
      { phase: 'preparing' },
      { phase: 'media', done: 0, total: 1 },
      { phase: 'media', done: 1, total: 1 },
      { phase: 'finishing' },
    ]);
    expect((await b.client.call('listProfiles')).map((p) => p.displayName)).toEqual(['Ana']);
    expect(await b.client.call('listBlobHashes')).toEqual([sha256]);
    expect(await b.deps.blobStore.verify(sha256)).toBe('ok');
  });

  test('the archive from the client path is the same format the direct path reads', async () => {
    const { lib: a } = await withMedia();
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: '1' });
    const direct = await library();
    await restoreArchiveIntoEmptyLibrary(direct, blob);
    expect(direct.db.all('SELECT display_name FROM profiles')).toEqual([{ display_name: 'Ana' }]);
  });

  test('restoring into a library that has data is refused and changes nothing', async () => {
    const { lib: a } = await withMedia();
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: '1' });
    const b = await createTestLibrary();
    await b.client.call('createProfile', { id: ID, displayName: 'Bo', now: '2026-01-01T00:00:00Z' });
    await expect(restoreArchiveFromZip(b.deps, blob)).rejects.toMatchObject({ name: 'ArchiveError', code: 'target-not-empty' });
    expect((await b.client.call('listProfiles')).map((p) => p.displayName)).toEqual(['Bo']);
    expect(await b.deps.blobStore.list()).toEqual([]);
  });

  test('the worker itself refuses a non-empty target (not only the page check)', async () => {
    const b = await createTestLibrary();
    await b.client.call('createProfile', { id: ID, displayName: 'Bo', now: '2026-01-01T00:00:00Z' });
    await expect(b.client.call('restoreDatabase', { database: new Uint8Array(200), blobs: [] })).rejects.toMatchObject({ code: 'constraint' });
    await expect(b.client.call('restoreDatabase', { database: 'x' as unknown as Uint8Array, blobs: [] })).rejects.toMatchObject({ code: 'invalid' });
  });

  test('a file that is not an archive, and a tampered one, fail with ArchiveError and leave the library empty', async () => {
    const b = await createTestLibrary();
    await expect(restoreArchiveFromZip(b.deps, new Blob(['not a zip at all']))).rejects.toMatchObject({ code: 'not-an-archive' });
    const { lib: a } = await withMedia();
    const { blob } = await exportArchiveFromLibrary(a.deps, { appVersion: '1' });
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const dbName = Object.keys(files).find((n) => n.endsWith('.sqlite'))!;
    files[dbName] = files[dbName].slice().fill(7, 200, 400);
    const { zipSync } = await import('fflate');
    await expect(restoreArchiveFromZip(b.deps, new Blob([zipSync(files)]))).rejects.toMatchObject({ name: 'ArchiveError' });
    expect(await b.client.call('isLibraryEmpty')).toBe(true);
    expect(await b.deps.blobStore.list()).toEqual([]);
  });

  test('export fails with blob-missing when a referenced file is gone, and a second operation is busy', async () => {
    const { lib: a, sha256 } = await withMedia();
    const running = exportArchiveFromLibrary(a.deps, { appVersion: '1' });
    await expect(exportArchiveFromLibrary(a.deps, { appVersion: '1' })).rejects.toMatchObject({ code: 'busy' });
    await running;
    await a.deps.blobStore.delete(sha256);
    await expect(exportArchiveFromLibrary(a.deps, { appVersion: '1' })).rejects.toMatchObject({ code: 'blob-missing' });
  });
});

describe('a large archive', () => {
  test('output past the folding threshold still restores byte for byte', async () => {
    const a = await library();
    const big = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24);
    const { sha256, size } = await a.blobStore.put(big);
    a.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [sha256, size]);
    const { blob } = await exportArchive(a, { appVersion: '1' });
    const b = await library();
    await restoreArchiveIntoEmptyLibrary(b, blob);
    expect(await b.blobStore.verify(sha256)).toBe('ok');
    expect(await b.blobStore.size(sha256)).toBe(size);
  }, 60_000);
});

