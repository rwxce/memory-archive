import { Zip, ZipPassThrough, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeEach, describe, expect, test } from 'vitest';
import { sha256Hex } from '../../domain/sha256';
import { SCHEMA_VERSION, migrate, MIGRATIONS } from '../../db/migrations';
import { openMemoryDb } from '../../db/open';
import { createConversation, createProfile, importMessages } from '../../db/queries';
import { isLibraryEmpty, serializeDb } from '../../db/snapshot';
import { wrapOo1Db, type SqlDb } from '../../db/sql';
import { readZipEntries } from '../../importers/whatsapp/zip';
import { openBlobStore } from '../../storage/opfs-blob-store';
import { createMemoryDirectory } from '../../storage/test-opfs-directory';
import type { BlobStore } from '../../storage/blob-store';
import { exportArchive, restoreArchiveIntoEmptyLibrary, type ArchiveLibrary } from '../../usecases/archive';
import { ArchiveError, DB_PATH, MANIFEST_PATH, blobPath, parseManifest, validateEntryPath, type ArchiveManifest } from './format';
import { writeArchive } from './write';

const enc = (s: string) => new TextEncoder().encode(s);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fp = (n: number) => n.toString(16).padStart(64, '0');
const NOW = '2026-02-01T12:00:00Z';
const PHOTO = enc('synthetic photo bytes '.repeat(50));
const VIDEO = new Uint8Array(70_000).map((_, i) => (i * 31) % 251);
const NOTE = enc('synthetic voice note');
/** Referenced only by a profile photo, never by a message. */
const AVATAR = enc('synthetic avatar bytes');

async function newLibrary(): Promise<ArchiveLibrary> {
  return { db: (await openMemoryDb()).db, blobStore: await openBlobStore(createMemoryDirectory()) };
}

async function seed({ db, blobStore }: ArchiveLibrary): Promise<void> {
  const blobs = [];
  for (const bytes of [PHOTO, VIDEO, NOTE]) {
    const { sha256, size } = await blobStore.put(bytes);
    blobs.push({ sha256, size, mime: bytes === PHOTO ? 'image/jpeg' : bytes === VIDEO ? 'video/mp4' : null });
  }
  const avatar = await blobStore.put(AVATAR);
  createProfile(db, { id: uuid(1), displayName: 'Ana', relationship: 'friend', description: 'Met at school.\nSynthetic.', photo: { ...avatar, mime: 'image/png' }, now: NOW });
  createProfile(db, { id: uuid(2), displayName: 'Bo', now: NOW });
  createProfile(db, { id: uuid(3), displayName: 'Zoë 山田', now: NOW });
  db.run('UPDATE profiles SET archived_at = ? WHERE id = ?', ['2026-02-02T00:00:00Z', uuid(3)]);
  createConversation(db, { id: uuid(10), title: 'Chat A', source: 'whatsapp', isGroup: false, profileIds: [uuid(1)], participants: [{ displayName: 'Ana', profileId: uuid(1) }], now: NOW });
  createConversation(db, { id: uuid(11), title: 'Group B', source: 'whatsapp', isGroup: true, profileIds: [uuid(1), uuid(2)], participants: [], now: NOW });
  const message = (n: number, over = {}) => ({
    fingerprint: fp(n),
    sentAt: `2026-01-01T10:0${n}:00`,
    ordinal: 0,
    type: 'text' as const,
    participantName: n % 2 ? 'Ana' : 'Bo',
    body: `synthetic message ${n}`,
    mediaSha256: null,
    mediaName: '',
    ...over,
  });
  const photo = { type: 'photo' as const, mediaSha256: blobs[0].sha256, mediaName: 'IMG-1.jpg' };
  importMessages(db, {
    batchId: uuid(100), conversationId: uuid(10), source: 'whatsapp', sourceLabel: 'a.zip', now: NOW,
    blobs: blobs.slice(0, 2),
    messages: [message(1, { body: 'Hola, què tal? ñandú — 日本語 😀 café' }), message(2, photo), message(3, { type: 'video', mediaSha256: blobs[1].sha256, mediaName: 'VID-1.mp4' })],
  });
  importMessages(db, {
    batchId: uuid(101), conversationId: uuid(11), source: 'whatsapp', sourceLabel: 'b.zip', now: NOW,
    blobs: [blobs[0], blobs[2]],
    messages: [message(4, photo), message(5, { type: 'audio', mediaSha256: blobs[2].sha256, mediaName: 'PTT-1.opus' }), message(6)],
  });
}

function dump(db: SqlDb): Record<string, unknown[]> {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return Object.fromEntries(tables.map(({ name }) => [name, db.all(`SELECT * FROM "${name}" ORDER BY rowid`)]));
}

async function exported(): Promise<{ lib: ArchiveLibrary; bytes: Uint8Array; blob: Blob }> {
  const lib = await newLibrary();
  await seed(lib);
  const { blob } = await exportArchive(lib, { appVersion: '0.0.0-test', now: new Date('2026-03-04T05:06:07Z') });
  return { lib, bytes: new Uint8Array(await blob.arrayBuffer()), blob };
}

type Parts = Record<string, Uint8Array>;
const zipped = (parts: Parts, manifest?: (m: ArchiveManifest) => unknown): Blob => {
  const files: Zippable = {};
  for (const [name, data] of Object.entries(parts)) {
    files[name] = name === MANIFEST_PATH && manifest ? [enc(JSON.stringify(manifest(JSON.parse(new TextDecoder().decode(data))))), { level: 6 }] : [data, { level: 0 }];
  }
  return new Blob([zipSync(files) as BlobPart]);
};
const partsOf = (bytes: Uint8Array): Parts => unzipSync(bytes);
const manifestOf = (parts: Parts): ArchiveManifest => JSON.parse(new TextDecoder().decode(parts[MANIFEST_PATH]));

async function expectRejected(zip: Blob, code: string, options?: Parameters<typeof restoreArchiveIntoEmptyLibrary>[2]) {
  const target = await newLibrary();
  const error = await restoreArchiveIntoEmptyLibrary(target, zip, options).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ArchiveError);
  expect((error as ArchiveError).code).toBe(code);
  expect(isLibraryEmpty(target.db)).toBe(true);
  expect(await target.blobStore.list()).toEqual([]);
}

let source: Awaited<ReturnType<typeof exported>>;
beforeEach(async () => {
  source = await exported();
});

describe('export and restore', () => {
  test('round trip restores every table row by row and every blob', async () => {
    const target = await newLibrary();
    const result = await restoreArchiveIntoEmptyLibrary(target, source.blob);
    expect(result.blobCount).toBe(4);
    expect(dump(target.db)).toEqual(dump(source.lib.db));
    expect(await target.blobStore.list()).toEqual(await source.lib.blobStore.list());
    expect(dump(target.db).messages).toHaveLength(6);
    expect(target.db.all('SELECT body FROM messages WHERE body LIKE ?', ['Hola%'])).toEqual([{ body: 'Hola, què tal? ñandú — 日本語 😀 café' }]);
    expect(target.db.all('SELECT display_name, archived_at FROM profiles WHERE id = ?', [uuid(3)])).toEqual([{ display_name: 'Zoë 山田', archived_at: '2026-02-02T00:00:00Z' }]);
    expect(target.db.all('SELECT relationship, description, photo_sha256 FROM profiles WHERE id = ?', [uuid(1)])).toEqual([
      { relationship: 'friend', description: 'Met at school.\nSynthetic.', photo_sha256: sha256Hex(AVATAR) },
    ]);
    expect(target.db.all('SELECT mime FROM blobs ORDER BY mime')).toEqual([{ mime: null }, { mime: 'image/jpeg' }, { mime: 'image/png' }, { mime: 'video/mp4' }]);
    // The avatar is referenced by the profile photo only, and survives backup and restore.
    expect(await target.blobStore.verify(sha256Hex(AVATAR))).toBe('ok');
    expect(target.db.all('SELECT sha256 FROM blobs WHERE sha256 = ?', [sha256Hex(AVATAR)])).toHaveLength(1);
    expect(target.db.all('SELECT 1 FROM messages WHERE media_sha256 = ?', [sha256Hex(AVATAR)])).toEqual([]);
    expect(target.db.all('SELECT display_name, profile_id FROM participants WHERE profile_id IS NOT NULL')).toEqual([{ display_name: 'Ana', profile_id: uuid(1) }]);
    expect(dump(target.db).messages.some((m) => (m as { media_sha256: unknown }).media_sha256 === null)).toBe(true);
    for (const sha of await target.blobStore.list()) expect(await target.blobStore.verify(sha)).toBe('ok');
  });

  test('the file has the documented layout: manifest first and deflated, the rest stored', async () => {
    const entries = await readZipEntries(source.blob);
    expect(entries[0].name).toBe(MANIFEST_PATH);
    expect(entries[0].compression).toBe(8);
    expect(entries[1].name).toBe(DB_PATH);
    expect(entries.slice(1).every((e) => e.compression === 0)).toBe(true);
    const manifest = manifestOf(partsOf(source.bytes));
    expect(manifest).toMatchObject({ format: 'memory-archive', formatVersion: 1, schemaVersion: SCHEMA_VERSION, createdAt: '2026-03-04T05:06:07.000Z', app: { name: 'memory-archive', version: '0.0.0-test' } });
    expect(manifest.entries.map((e) => e.path)).toEqual(entries.slice(1).map((e) => e.name));
    expect(manifest.entries[0].sha256).toBe(sha256Hex(partsOf(source.bytes)[DB_PATH]));
    expect(manifest.entries.slice(1).map((e) => e.path)).toContain(blobPath(sha256Hex(PHOTO)));
  });

  test('an archive made by schema v1 (before profile details) still restores, migrated to the current schema', async () => {
    const { default: init } = await import('@sqlite.org/sqlite-wasm');
    const sqlite3 = await init();
    const v1 = wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3.capi);
    v1.exec('PRAGMA foreign_keys = ON');
    migrate(v1, MIGRATIONS.slice(0, 1));
    v1.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [uuid(1), 'Ana', NOW, NOW]);
    const blob = await writeArchive({
      app: { name: 'memory-archive', version: '0.0.0-v1' },
      createdAt: new Date('2026-03-04T05:06:07Z'),
      schemaVersion: 1,
      database: serializeDb(v1),
      blobs: [],
      openBlob: async () => new Blob([]).stream(),
    });
    const target = await newLibrary();
    await restoreArchiveIntoEmptyLibrary(target, blob);
    expect(target.db.all('SELECT display_name, relationship, description, photo_sha256 FROM profiles')).toEqual([
      { display_name: 'Ana', relationship: '', description: '', photo_sha256: null },
    ]);
  });

  test('export names the file by UTC date', async () => {
    const { fileName } = await exportArchive(source.lib, { appVersion: '1', now: new Date('2026-12-31T23:59:59Z') });
    expect(fileName).toBe('memory-archive-2026-12-31.zip');
  });

  test('export fails when a referenced media file is missing', async () => {
    await source.lib.blobStore.delete(sha256Hex(VIDEO));
    await expect(exportArchive(source.lib, { appVersion: '1' })).rejects.toMatchObject({ code: 'blob-missing' });
  });

  test('a row added while the export is checking media is in neither the manifest nor the snapshot', async () => {
    const lib = source.lib;
    let inserted = false;
    const racing: BlobStore = {
      ...lib.blobStore,
      size: async (sha256) => {
        if (!inserted) {
          inserted = true;
          lib.db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', ['ee'.repeat(32), 7]);
        }
        return lib.blobStore.size(sha256);
      },
    };
    const { blob, blobCount } = await exportArchive({ db: lib.db, blobStore: racing }, { appVersion: '1' });
    expect(inserted).toBe(true);
    expect(blobCount).toBe(4);
    const target = await newLibrary();
    await restoreArchiveIntoEmptyLibrary(target, blob);
    expect(target.db.all('SELECT sha256 FROM blobs')).toHaveLength(4);
    expect(await target.blobStore.list()).toEqual(await source.lib.blobStore.list());
  });

  test('an export restore would refuse fails up front, for every limit', async () => {
    for (const limits of [{ maxEntries: 5 }, { maxDatabaseBytes: 1000 }, { maxEntryBytes: 1000 }, { maxTotalBytes: 1000 }, { maxCentralDirectoryBytes: 100 }]) {
      await expect(exportArchive(source.lib, { appVersion: '1', limits }), JSON.stringify(limits)).rejects.toMatchObject({ code: 'limit-exceeded' });
    }
    // the same limits that block the export are the ones restore applies
    const limits = { maxEntries: 6 };
    await expect(exportArchive(source.lib, { appVersion: '1', limits })).resolves.toMatchObject({ blobCount: 4 });
  });

  test('export aborts when a blob no longer matches its hash', async () => {
    const wrong = new Uint8Array(PHOTO);
    wrong[3] ^= 1;
    await expect(
      writeArchive({
        app: { name: 'memory-archive', version: '1' },
        createdAt: new Date(),
        schemaVersion: 1,
        database: new Uint8Array(10),
        blobs: [{ sha256: sha256Hex(PHOTO), size: PHOTO.length }],
        openBlob: async () => new Blob([wrong as BlobPart]).stream(),
      }),
    ).rejects.toMatchObject({ code: 'integrity' });
  });
});

describe('restore rejects hostile or damaged archives and leaves the target empty', () => {
  const withEntry = (name: string): Blob => {
    const parts = partsOf(source.bytes);
    parts[name] = enc('x');
    return zipped(parts);
  };

  test.each([
    ['parent traversal', '../evil'],
    ['nested traversal', 'blobs/../../evil'],
    ['absolute path', '/etc/passwd'],
    ['backslash', 'blobs\\aa\\evil'],
    ['drive letter', 'C:/evil'],
  ])('unsafe path: %s', async (_label, name) => {
    await expectRejected(withEntry(name), 'unsafe-path');
  });

  test('a manifest that lists an unsafe path', async () => {
    const parts = partsOf(source.bytes);
    await expectRejected(zipped(parts, (m) => ({ ...m, entries: [...m.entries, { path: '../x', size: 1, sha256: 'a'.repeat(64) }] })), 'unsafe-path');
  });

  test('a manifest that lists a path of the wrong shape', async () => {
    const parts = partsOf(source.bytes);
    await expectRejected(zipped(parts, (m) => ({ ...m, entries: [...m.entries, { path: 'notes/x.txt', size: 1, sha256: 'a'.repeat(64) }] })), 'invalid-manifest');
  });

  test('duplicate entry names', async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((_e, c) => chunks.push(c));
    for (const data of ['one', 'two']) {
      const f = new ZipPassThrough('blobs/aa/' + 'a'.repeat(62) + 'aa');
      zip.add(f);
      f.push(enc(data), true);
    }
    zip.end();
    await expectRejected(new Blob(chunks as BlobPart[]), 'duplicate-entry');
  });

  test('an entry the manifest does not list', async () => {
    await expectRejected(withEntry('blobs/ab/' + 'ab'.repeat(32)), 'entry-mismatch');
  });

  test('a listed entry that is not in the archive', async () => {
    const parts = partsOf(source.bytes);
    delete parts[blobPath(sha256Hex(NOTE))];
    await expectRejected(zipped(parts), 'entry-mismatch');
  });

  test('a tampered blob (same size) fails its hash; blobs already stored are removed', async () => {
    const parts = partsOf(source.bytes);
    const last = manifestOf(parts).entries.at(-1)!;
    const bytes = new Uint8Array(parts[last.path]);
    bytes[0] ^= 0xff;
    parts[last.path] = bytes;
    await expectRejected(zipped(parts), 'integrity');
  });

  test('a blob whose size differs from the manifest', async () => {
    const parts = partsOf(source.bytes);
    const path = blobPath(sha256Hex(PHOTO));
    parts[path] = parts[path].slice(0, 10);
    await expectRejected(zipped(parts), 'integrity');
  });

  test('a tampered database fails its hash', async () => {
    const parts = partsOf(source.bytes);
    const db = new Uint8Array(parts[DB_PATH]);
    db[db.length - 1] ^= 1;
    parts[DB_PATH] = db;
    await expectRejected(zipped(parts), 'integrity');
  });

  test('missing manifest', async () => {
    const parts = partsOf(source.bytes);
    delete parts[MANIFEST_PATH];
    await expectRejected(zipped(parts), 'invalid-manifest');
  });

  test('garbage manifest', async () => {
    const parts = partsOf(source.bytes);
    parts[MANIFEST_PATH] = enc('{ not json');
    await expectRejected(zipped(parts), 'invalid-manifest');
  });

  test('wrong format name', async () => {
    await expectRejected(zipped(partsOf(source.bytes), (m) => ({ ...m, format: 'something-else' })), 'invalid-manifest');
  });

  test('newer format version is refused with a clear code', async () => {
    await expectRejected(zipped(partsOf(source.bytes), (m) => ({ ...m, formatVersion: 2 })), 'newer-format');
  });

  test('newer schema version is refused with a clear code', async () => {
    await expectRejected(zipped(partsOf(source.bytes), (m) => ({ ...m, schemaVersion: SCHEMA_VERSION + 1 })), 'newer-schema');
  });

  test('too many entries', async () => {
    await expectRejected(source.blob, 'limit-exceeded', { limits: { maxEntries: 3 } });
  });

  test('an oversized entry', async () => {
    await expectRejected(source.blob, 'limit-exceeded', { limits: { maxEntryBytes: 1000 } });
  });

  test('a database over its own cap, even when media would fit', async () => {
    await expectRejected(source.blob, 'limit-exceeded', { limits: { maxDatabaseBytes: 1000 } });
  });

  test('a central directory over its cap is refused before it is read', async () => {
    await expectRejected(source.blob, 'limit-exceeded', { limits: { maxCentralDirectoryBytes: 100 } });
  });

  test('total size over the cap', async () => {
    await expectRejected(source.blob, 'limit-exceeded', { limits: { maxTotalBytes: 1000 } });
  });

  test('a compression bomb is refused from its directory entry', async () => {
    const bomb = zipSync({ [MANIFEST_PATH]: [new Uint8Array(5_000_000), { level: 9 }] });
    await expectRejected(new Blob([bomb as BlobPart]), 'limit-exceeded');
  });

  test('a compression bomb that lies about its size is stopped by counting real bytes', async () => {
    const bomb = zipSync({ [MANIFEST_PATH]: [new Uint8Array(5_000_000), { level: 9 }] });
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    let cd = bomb.length - 22;
    while (view.getUint32(cd, true) !== 0x02014b50) cd--;
    view.setUint32(cd + 24, 2000, true);
    await expectRejected(new Blob([bomb as BlobPart]), 'limit-exceeded');
  });

  test('a ZIP cut in half is not an archive', async () => {
    await expectRejected(source.blob.slice(0, Math.floor(source.blob.size / 2)), 'not-an-archive');
  });

  test('intact directories but corrupt compressed manifest data', async () => {
    const bytes = new Uint8Array(source.bytes);
    const view = new DataView(bytes.buffer);
    const dataAt = 30 + view.getUint16(26, true) + view.getUint16(28, true); // manifest is the first entry
    bytes.fill(0xff, dataAt, dataAt + 16);
    await expectRejected(new Blob([bytes as BlobPart]), 'not-an-archive');
  });

  test('a blob whose data ends before the size the directory and manifest declare', async () => {
    const parts = partsOf(source.bytes);
    const last = manifestOf(parts).entries.at(-1)!;
    const declared = last.size + 5_000_000;
    const bytes = new Uint8Array(await zipped(parts, (m) => ({ ...m, entries: m.entries.map((e) => (e.path === last.path ? { ...e, size: declared } : e)) })).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let cd = bytes.length - 22;
    while (view.getUint32(cd, true) !== 0x06054b50) cd--;
    let at = view.getUint32(cd + 16, true);
    let lastRecord = at;
    while (view.getUint32(at, true) === 0x02014b50) {
      lastRecord = at;
      at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    view.setUint32(lastRecord + 20, declared, true);
    view.setUint32(lastRecord + 24, declared, true);
    await expectRejected(new Blob([bytes as BlobPart]), 'not-an-archive');
  });

  test('a manifest that repeats a blob path', async () => {
    await expectRejected(zipped(partsOf(source.bytes), (m) => ({ ...m, entries: [...m.entries, m.entries[1]] })), 'duplicate-entry');
  });

  test('a deflated blob entry is held to the compression ratio', async () => {
    const zeros = new Uint8Array(200_000);
    const sha = sha256Hex(zeros);
    const parts = partsOf(source.bytes);
    const manifest = manifestOf(parts);
    manifest.entries.push({ path: blobPath(sha), size: zeros.length, sha256: sha });
    const bomb = zipSync({
      [MANIFEST_PATH]: [strToU8(JSON.stringify(manifest)), { level: 6 }],
      [DB_PATH]: [parts[DB_PATH], { level: 0 }],
      [blobPath(sha)]: [zeros, { level: 9 }],
    });
    await expectRejected(new Blob([bomb as BlobPart]), 'limit-exceeded');
  });

  test('not a ZIP at all', async () => {
    await expectRejected(new Blob([enc('hello, I am not a zip file at all')]), 'not-an-archive');
  });

  test('a corrupted SQLite file with a consistent manifest; stored blobs are removed', async () => {
    const parts = partsOf(source.bytes);
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
    parts[DB_PATH] = garbage;
    await expectRejected(
      zipped(parts, (m) => ({ ...m, entries: m.entries.map((e) => (e.path === DB_PATH ? { ...e, size: garbage.length, sha256: sha256Hex(garbage) } : e)) })),
      'invalid-database',
    );
  });

  test('a database whose media references differ from the archive blobs', async () => {
    const parts = partsOf(source.bytes);
    const path = blobPath(sha256Hex(NOTE));
    delete parts[path];
    await expectRejected(zipped(parts, (m) => ({ ...m, entries: m.entries.filter((e) => e.path !== path) })), 'invalid-database');
  });

  test('a library with rows is not overwritten', async () => {
    const target = await newLibrary();
    createProfile(target.db, { id: uuid(9), displayName: 'Cy', now: NOW });
    await expect(restoreArchiveIntoEmptyLibrary(target, source.blob)).rejects.toMatchObject({ code: 'target-not-empty' });
    expect(await target.blobStore.list()).toEqual([]);
  });

  test('media files without any database row are leftovers: swept, then the restore succeeds', async () => {
    const target = await newLibrary();
    const stray = await target.blobStore.put(enc('left behind by an interrupted import'));
    await restoreArchiveIntoEmptyLibrary(target, source.blob);
    expect(await target.blobStore.list()).toEqual(await source.lib.blobStore.list());
    expect(await target.blobStore.has(stray.sha256)).toBe(false);
    expect(dump(target.db)).toEqual(dump(source.lib.db));
  });

  test('a failed restore whose cleanup also fails reports it, and a retry succeeds', async () => {
    const target = await newLibrary();
    const parts = partsOf(source.bytes);
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
    parts[DB_PATH] = garbage;
    const bad = zipped(parts, (m) => ({ ...m, entries: m.entries.map((e) => (e.path === DB_PATH ? { ...e, size: garbage.length, sha256: sha256Hex(garbage) } : e)) }));
    const stuck: BlobStore = { ...target.blobStore, delete: async () => { throw new Error('io'); } };
    const error = await restoreArchiveIntoEmptyLibrary({ db: target.db, blobStore: stuck }, bad).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid-database', leftoverBlobs: 4 });
    expect(isLibraryEmpty(target.db)).toBe(true);
    expect(await target.blobStore.list()).toHaveLength(4);
    await restoreArchiveIntoEmptyLibrary(target, source.blob);
    expect(dump(target.db)).toEqual(dump(source.lib.db));
    expect(await target.blobStore.list()).toEqual(await source.lib.blobStore.list());
  });

  test('leftover media that cannot be swept stops the restore with a storage error', async () => {
    const target = await newLibrary();
    await target.blobStore.put(enc('stray'));
    const stuck: BlobStore = { ...target.blobStore, delete: async () => { throw new Error('io'); } };
    await expect(restoreArchiveIntoEmptyLibrary({ db: target.db, blobStore: stuck }, source.blob)).rejects.toMatchObject({ code: 'storage' });
    expect(isLibraryEmpty(target.db)).toBe(true);
  });

  test('a failing blob store leaves the library empty', async () => {
    const target = await newLibrary();
    const store: BlobStore = { ...target.blobStore, put: async () => { throw new Error('disk full'); } };
    await expect(restoreArchiveIntoEmptyLibrary({ db: target.db, blobStore: store }, source.blob)).rejects.toMatchObject({ code: 'storage' });
    expect(isLibraryEmpty(target.db)).toBe(true);
  });
});

describe('format helpers', () => {
  test('validateEntryPath accepts the archive shapes and rejects odd names', () => {
    expect(() => validateEntryPath(DB_PATH)).not.toThrow();
    expect(() => validateEntryPath(blobPath('ab'.repeat(32)))).not.toThrow();
    for (const bad of ['', 'a//b', 'a/', './a', 'a/./b', 'a\u0000b', 'caf\u00e9', 'a b']) {
      expect(() => validateEntryPath(bad), bad).toThrowError(expect.objectContaining({ code: 'unsafe-path' }));
    }
  });

  test('parseManifest refuses a database entry that is missing or repeated', () => {
    const base = { format: 'memory-archive', formatVersion: 1, createdAt: NOW, app: { name: 'a', version: '1' }, schemaVersion: SCHEMA_VERSION };
    const entry = { path: DB_PATH, size: 1, sha256: 'a'.repeat(64) };
    for (const [entries, code] of [[[], 'invalid-manifest'], [[entry, entry], 'duplicate-entry']] as const) {
      expect(() => parseManifest(enc(JSON.stringify({ ...base, entries })), SCHEMA_VERSION)).toThrowError(expect.objectContaining({ code }));
    }
  });
});
