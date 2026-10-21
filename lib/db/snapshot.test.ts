import { describe, expect, test } from 'vitest';
import { MIGRATIONS, migrate, type Migration } from './migrations';
import { openMemoryDb } from './open';
import { createConversation, createProfile } from './queries';
import { isLibraryEmpty, listBlobs, loadSnapshot, serializeDb } from './snapshot';
import { wrapOo1Db, type SqlDb } from './sql';

const NOW = '2026-02-01T12:00:00Z';
const ID1 = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const ID2 = '7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const V2: readonly Migration[] = [MIGRATIONS[0], { version: 2, sql: 'ALTER TABLE profiles ADD COLUMN note TEXT' }];

/** A bare in-memory database (same engine as production), optionally migrated. */
async function bareDb(migrations?: readonly Migration[]): Promise<SqlDb> {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'), sqlite3.capi);
  db.exec('PRAGMA foreign_keys = ON');
  if (migrations) migrate(db, migrations);
  return db;
}

const profile = (db: SqlDb, id: string) => createProfile(db, { id, displayName: 'Ana', now: NOW });
const code = (p: Promise<unknown>) => p.then(() => undefined, (e: { code?: string }) => e.code);

/** Loads `source` into a fresh target, expects `invalid` with a message matching `why`, and an untouched target. */
async function expectInvalid(source: SqlDb, why: RegExp, target?: SqlDb): Promise<void> {
  const into = target ?? (await openMemoryDb()).db;
  const error = await loadSnapshot(into, serializeDb(source)).then(() => undefined, (e: unknown) => e);
  expect(error).toMatchObject({ code: 'invalid', message: expect.stringMatching(why) });
  expect(isLibraryEmpty(into)).toBe(true);
}

describe('serializeDb / isLibraryEmpty / listBlobs', () => {
  test('serializeDb returns a SQLite file; a handle without the C API cannot', async () => {
    const { db } = await openMemoryDb();
    expect(new TextDecoder().decode(serializeDb(db).slice(0, 15))).toBe('SQLite format 3');
    expect(() => serializeDb({ ...db, serialize: undefined })).toThrowError(/cannot be serialized/);
  });

  test('isLibraryEmpty turns false with the first row of any table', async () => {
    const { db } = await openMemoryDb();
    expect(isLibraryEmpty(db)).toBe(true);
    db.run("INSERT INTO blobs (sha256, size) VALUES (?, 1)", ['ab'.repeat(32)]);
    expect(isLibraryEmpty(db)).toBe(false);
    expect(listBlobs(db)).toEqual([{ sha256: 'ab'.repeat(32), size: 1 }]);
  });
});

describe('loadSnapshot', () => {
  test('loads the same schema and keeps ids', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(source))).toEqual({ from: 1, to: 1 });
    expect(target.all('SELECT * FROM profiles')).toEqual(source.all('SELECT * FROM profiles'));
  });

  test('migrates an older snapshot to the current schema before copying', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    profile(source, ID2);
    const target = await bareDb(V2);
    expect(await loadSnapshot(target, serializeDb(source), { migrations: V2 })).toEqual({ from: 1, to: 2 });
    expect(target.all('SELECT id, display_name, note FROM profiles ORDER BY id')).toEqual([
      { id: ID1, display_name: 'Ana', note: null },
      { id: ID2, display_name: 'Ana', note: null },
    ]);
  });

  test('refuses a snapshot from a newer schema and leaves the target alone', async () => {
    const newer = await bareDb(V2);
    profile(newer, ID1);
    const target = (await openMemoryDb()).db;
    expect(await code(loadSnapshot(target, serializeDb(newer)))).toBe('newer-schema');
    expect(isLibraryEmpty(target)).toBe(true);
  });

  test('refuses bytes that are not SQLite (short and long)', async () => {
    const target = (await openMemoryDb()).db;
    expect(await code(loadSnapshot(target, new Uint8Array(10)))).toBe('invalid');
    expect(await code(loadSnapshot(target, new Uint8Array(8192).fill(7)))).toBe('invalid');
    expect(isLibraryEmpty(target)).toBe(true);
  });

  test('refuses a snapshot with triggers', async () => {
    const source = (await openMemoryDb()).db;
    source.exec('CREATE TRIGGER sneaky AFTER INSERT ON profiles BEGIN SELECT 1; END');
    await expectInvalid(source, /triggers, views/);
  });

  test('refuses a view and a virtual table before migrating anything', async () => {
    const view = (await openMemoryDb()).db;
    view.exec('CREATE VIEW sneaky AS SELECT id FROM profiles');
    await expectInvalid(view, /triggers, views/);
    const virtual = (await openMemoryDb()).db;
    virtual.exec('CREATE VIRTUAL TABLE sneaky USING fts5(body)');
    await expectInvalid(virtual, /virtual tables/);
  });

  test('a trigger in an older snapshot is refused before the migration could fire it', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    source.exec("CREATE TRIGGER sneaky AFTER UPDATE ON profiles BEGIN UPDATE profiles SET display_name = 'pwned'; END");
    const target = await bareDb(V2);
    await expectInvalid(source, /triggers, views/, target);
  });

  test('refuses when the target schema is not the snapshot schema after migration', async () => {
    const source = (await openMemoryDb()).db;
    const target = await bareDb(V2);
    await expectInvalid(source, /schema version differs/, target);
  });

  test('refuses an extra table, an extra column and a missing column at the current version', async () => {
    const extraTable = (await openMemoryDb()).db;
    extraTable.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)');
    await expectInvalid(extraTable, /tables differ/);
    const extraColumn = (await openMemoryDb()).db;
    extraColumn.exec('ALTER TABLE profiles ADD COLUMN extra TEXT');
    await expectInvalid(extraColumn, /columns of profiles differ/);
    const missingColumn = (await openMemoryDb()).db;
    missingColumn.exec('ALTER TABLE blobs DROP COLUMN mime');
    await expectInvalid(missingColumn, /columns of blobs differ/);
  });

  test('refuses foreign key violations (orphan row written with foreign keys off)', async () => {
    const source = (await openMemoryDb()).db;
    source.exec('PRAGMA foreign_keys = OFF');
    source.run('INSERT INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [ID1, ID2]);
    await expectInvalid(source, /foreign key/);
  });

  test('refuses a database that fails SQLite integrity_check', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    const bytes = serializeDb(source);
    const id = new TextEncoder().encode(ID1);
    const at = bytes.findIndex((_, i) => id.every((b, k) => bytes[i + k] === b));
    expect(at).toBeGreaterThan(0);
    bytes[at + id.length - 1] = bytes[at + id.length - 1] === 0x30 ? 0x31 : 0x30; // table and index no longer agree
    const target = (await openMemoryDb()).db;
    const error = await loadSnapshot(target, bytes).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid', message: expect.stringMatching(/integrity/) });
    expect(isLibraryEmpty(target)).toBe(true);
  });

  test('rows with negative rowids are copied, not silently dropped', async () => {
    const source = (await openMemoryDb()).db;
    createConversation(source, { id: ID1, title: 'C', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: NOW });
    for (const id of [-9, -1, 0, 4]) {
      source.run('INSERT INTO participants (id, conversation_id, display_name) VALUES (?, ?, ?)', [id, ID1, `P${id}`]);
    }
    const target = (await openMemoryDb()).db;
    await loadSnapshot(target, serializeDb(source));
    expect(target.all('SELECT id FROM participants ORDER BY id')).toEqual([{ id: -9 }, { id: -1 }, { id: 0 }, { id: 4 }]);
  });

  test('refuses media references that differ from the expected list', async () => {
    const source = (await openMemoryDb()).db;
    source.run('INSERT INTO blobs (sha256, size) VALUES (?, 1)', ['ab'.repeat(32)]);
    const target = (await openMemoryDb()).db;
    expect(await code(loadSnapshot(target, serializeDb(source), { expectBlobs: [] }))).toBe('invalid');
    expect(await loadSnapshot(target, serializeDb(source), { expectBlobs: [{ sha256: 'ab'.repeat(32), size: 1 }] })).toEqual({ from: 1, to: 1 });
  });

  test('is atomic: a conflict halfway rolls everything back', async () => {
    const source = (await openMemoryDb()).db;
    source.run('INSERT INTO blobs (sha256, size) VALUES (?, 1)', ['cd'.repeat(32)]);
    profile(source, ID1);
    const target = (await openMemoryDb()).db;
    profile(target, ID1);
    expect(await code(loadSnapshot(target, serializeDb(source)))).toBe('constraint');
    expect(target.all('SELECT * FROM blobs')).toEqual([]);
    expect(target.all('SELECT id FROM profiles')).toHaveLength(1);
  });
});
