import { describe, expect, test } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, migrate, type Migration } from './migrations';
import { openMemoryDb } from './open';
import { createConversation, createProfile, setNote } from './queries';
import { getDeviceId, nextChangeSeq, recordSent, recordTombstone } from './sync';
import { checkSnapshot, databaseDigest, isLibraryEmpty, listBlobs, loadSnapshot, serializeDb } from './snapshot';
import { wrapOo1Db, type SqlDb } from './sql';

const NOW = '2026-02-01T12:00:00Z';
const ID1 = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const ID2 = '7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
/** The released migrations plus a hypothetical next one: a database one version ahead of this build. */
const NEXT: readonly Migration[] = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, sql: 'ALTER TABLE profiles ADD COLUMN note TEXT' }];
const V1_ONLY = MIGRATIONS.slice(0, 1);

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

  test('the device row, tombstones and sync_peers alone do not make the library non-empty', async () => {
    const { db } = await openMemoryDb();
    expect(db.all('SELECT * FROM device')).toHaveLength(1);
    db.run('INSERT INTO sync_peers (peer_id) VALUES (?)', ['9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d']);
    expect(isLibraryEmpty(db)).toBe(true);
    recordTombstone(db, 'favorite', ID2, 'ab'.repeat(32), NOW);
    expect(isLibraryEmpty(db)).toBe(true);
    profile(db, ID1);
    expect(isLibraryEmpty(db)).toBe(false);
  });
});

describe('open conflicts of a changes-pack merge', () => {
  const PEER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const conflict = (db: SqlDb) =>
    db.run("INSERT INTO sync_conflicts (peer_id, kind, scope, key, incoming, detected_at) VALUES (?, 'profile', '', ?, '{}', 't')", [PEER, ID1]);

  test('they do not make the library non-empty, and a restore leaves them behind with the peers they belong to', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    conflict(source);
    const empty = (await openMemoryDb()).db;
    conflict(empty);
    expect(isLibraryEmpty(empty)).toBe(true);
    await loadSnapshot(empty, serializeDb(source));
    expect(empty.all('SELECT * FROM sync_conflicts')).toEqual([]);
    expect(empty.all('SELECT id FROM profiles')).toEqual([{ id: ID1 }]);

    const full = (await openMemoryDb()).db;
    profile(full, ID2);
    conflict(full);
    await loadSnapshot(full, serializeDb(source), { replace: true });
    expect(full.all('SELECT * FROM sync_conflicts')).toEqual([]);
  });
});

describe('loadSnapshot', () => {
  test('loads the same schema and keeps ids', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(source))).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(target.all('SELECT * FROM profiles')).toEqual(source.all('SELECT * FROM profiles'));
  });

  test('migrates an older snapshot to the current schema before copying', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    profile(source, ID2);
    const target = await bareDb(NEXT);
    expect(await loadSnapshot(target, serializeDb(source), { migrations: NEXT })).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 1 });
    expect(target.all('SELECT id, display_name, note FROM profiles ORDER BY id')).toEqual([
      { id: ID1, display_name: 'Ana', note: null },
      { id: ID2, display_name: 'Ana', note: null },
    ]);
  });

  test('a schema v1 snapshot (profile, conversation, message, media) restores by migrating to v2', async () => {
    const v1 = await bareDb(V1_ONLY);
    v1.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [ID1, 'Ana', NOW, NOW]);
    v1.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v1.run('INSERT INTO conversation_profiles VALUES (?, ?)', [ID2, ID1]);
    v1.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v1.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v1))).toEqual({ from: 1, to: SCHEMA_VERSION });
    expect(target.all('SELECT id, display_name, relationship, description, photo_sha256, archived_at FROM profiles')).toEqual([
      { id: ID1, display_name: 'Ana', relationship: '', description: '', photo_sha256: null, archived_at: null },
    ]);
    expect(target.all('SELECT conversation_id, profile_id FROM conversation_profiles')).toEqual([{ conversation_id: ID2, profile_id: ID1 }]);
    expect(target.all('SELECT id FROM messages')).toHaveLength(1);
  });

  test('a schema v2 snapshot (profile details, import batch) restores by migrating to v3 with defaults', async () => {
    const v2 = await bareDb(MIGRATIONS.slice(0, 2));
    v2.run('INSERT INTO profiles (id, display_name, relationship, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [ID1, 'Ana', 'friend', NOW, NOW]);
    v2.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v2.run('INSERT INTO participants (conversation_id, display_name) VALUES (?, ?)', [ID2, 'Ana']);
    v2.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v2.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v2))).toEqual({ from: 2, to: SCHEMA_VERSION });
    expect(target.all('SELECT relationship FROM profiles')).toEqual([{ relationship: 'friend' }]);
    expect(target.all('SELECT source_key FROM conversations')).toEqual([{ source_key: '' }]);
    expect(target.all('SELECT display_name, is_me FROM participants')).toEqual([{ display_name: 'Ana', is_me: 0 }]);
    expect(target.all('SELECT created_conversation FROM import_batches')).toEqual([{ created_conversation: 0 }]);
    expect(target.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: 'ab'.repeat(32) }]);
  });

  test('a schema v3 snapshot restores by migrating to the current schema, keeping its messages and gaining the timeline index', async () => {
    const v3 = await bareDb(MIGRATIONS.slice(0, 3));
    v3.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v3.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v3.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v3))).toEqual({ from: 3, to: SCHEMA_VERSION });
    expect(target.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: 'ab'.repeat(32) }]);
    expect(target.all("SELECT name FROM sqlite_master WHERE name = 'messages_by_time'")).toHaveLength(1);
  });

  test('a schema v4 snapshot restores by migrating to the current schema: messages kept, favorites, notes and highlights empty', async () => {
    const v4 = await bareDb(MIGRATIONS.slice(0, 4));
    v4.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v4.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v4.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v4))).toEqual({ from: 4, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(13);
    expect(target.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: 'ab'.repeat(32) }]);
    expect(target.all('SELECT * FROM favorites')).toEqual([]);
    expect(target.all('SELECT * FROM notes')).toEqual([]);
    expect(target.all('SELECT * FROM highlights')).toEqual([]);
  });

  test('a schema v5 snapshot restores by migrating to the current schema: messages and favorites kept, notes and highlights empty', async () => {
    const v5 = await bareDb(MIGRATIONS.slice(0, 5));
    v5.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v5.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v5.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    v5.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [ID2, 'ab'.repeat(32), NOW]);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v5))).toEqual({ from: 5, to: SCHEMA_VERSION });
    expect(target.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: 'ab'.repeat(32) }]);
    expect(target.all('SELECT fingerprint FROM favorites')).toEqual([{ fingerprint: 'ab'.repeat(32) }]);
    expect(target.all('SELECT * FROM notes')).toEqual([]);
  });

  test('a current (v8) snapshot round-trips with its index, favorites, notes and highlights, anchored by fingerprint', async () => {
    const source = (await openMemoryDb()).db;
    createConversation(source, { id: ID2, title: 'Chat', source: 'whatsapp', isGroup: false, profileIds: [], participants: [], now: NOW });
    source.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    source.run('INSERT INTO messages (id, conversation_id, batch_id, fingerprint, sent_at, type) VALUES (7, ?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    source.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [ID2, 'ab'.repeat(32), NOW]);
    // a dormant favorite (its message is not in the archive) travels too
    source.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [ID2, 'cd'.repeat(32), NOW]);
    createProfile(source, { id: ID1, displayName: 'Ana', now: NOW });
    const note = (kind: string, profile: string | null, conversation: string | null, fingerprint: string | null, body: string) =>
      source.run('INSERT INTO notes (kind, profile_id, conversation_id, fingerprint, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, profile, conversation, fingerprint, body, NOW, NOW]);
    note('profile', ID1, null, null, 'about Ana');
    note('conversation', null, ID2, null, 'about the chat');
    note('message', null, ID2, 'ab'.repeat(32), 'about a message');
    note('message', null, ID2, 'cd'.repeat(32), 'dormant');
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(source))).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(target.all("SELECT name FROM sqlite_master WHERE name = 'messages_by_time'")).toHaveLength(1);
    expect(target.all('SELECT * FROM favorites ORDER BY fingerprint')).toEqual(source.all('SELECT * FROM favorites ORDER BY fingerprint'));
    expect(target.all('SELECT * FROM notes ORDER BY body')).toEqual(source.all('SELECT * FROM notes ORDER BY body'));
    expect(target.all('SELECT * FROM notes')).toHaveLength(4);
    source.run("INSERT INTO highlights (conversation_id, id, category, title, summary, created_by, created_at, imported_at) VALUES (?, 'h', 'moment', 'T', 'S', 'me', ?, ?)", [ID2, NOW, NOW]);
    source.run("INSERT INTO highlight_messages (conversation_id, highlight_id, fingerprint, position) VALUES (?, 'h', ?, 0), (?, 'h', ?, 1)", [ID2, 'cd'.repeat(32), ID2, 'ab'.repeat(32)]);
    const target2 = (await openMemoryDb()).db;
    expect(await loadSnapshot(target2, serializeDb(source))).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(target2.all('SELECT * FROM highlights')).toEqual(source.all('SELECT * FROM highlights'));
    expect(target2.all('SELECT * FROM highlight_messages ORDER BY position')).toEqual(source.all('SELECT * FROM highlight_messages ORDER BY position'));
  });

  test('a schema v6 snapshot restores by migrating to the current schema: messages and notes kept, highlights empty', async () => {
    const v6 = await bareDb(MIGRATIONS.slice(0, 6));
    v6.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v6.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    v6.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [ID2, ID1, 'ab'.repeat(32), '2026-01-01T10:00:00', 'text']);
    v6.run("INSERT INTO notes (kind, conversation_id, body, created_at, updated_at) VALUES ('conversation', ?, 'kept', ?, ?)", [ID2, NOW, NOW]);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v6))).toEqual({ from: 6, to: SCHEMA_VERSION });
    expect(target.all('SELECT body FROM notes')).toEqual([{ body: 'kept' }]);
    expect(target.all('SELECT * FROM highlights')).toEqual([]);
    expect(target.all('SELECT * FROM highlight_messages')).toEqual([]);
  });

  test('a schema v10 snapshot restores by migrating: rows kept, the photo collection empty; a v11 snapshot keeps its photos', async () => {
    const v10 = await bareDb(MIGRATIONS.slice(0, 10));
    v10.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    v10.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [ID1, ID2, 'whatsapp', NOW]);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v10))).toEqual({ from: 10, to: SCHEMA_VERSION });
    expect(target.all('SELECT id FROM import_batches')).toEqual([{ id: ID1 }]);
    expect(target.all('SELECT * FROM photo_items')).toEqual([]);

    const source = (await openMemoryDb()).db;
    source.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', ['ab'.repeat(32)]);
    source.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'takeout', ?, 1)", [ID1, NOW]);
    source.run("INSERT INTO photo_items (batch_id, sha256, kind, source, album, file_name) VALUES (?, ?, 'photo', 'takeout', 'A', 'a.jpg')", [ID1, 'ab'.repeat(32)]);
    const restored = (await openMemoryDb()).db;
    await loadSnapshot(restored, serializeDb(source), { expectBlobs: [{ sha256: 'ab'.repeat(32), size: 1 }] });
    expect(restored.all('SELECT album, file_name FROM photo_items')).toEqual([{ album: 'A', file_name: 'a.jpg' }]);
    expect(isLibraryEmpty(restored)).toBe(false);
    expect(isLibraryEmpty(source)).toBe(false);
  });

  test('a schema v11 snapshot restores by migrating: photo dates get their source; a v12 snapshot keeps it', async () => {
    const v11 = await bareDb(MIGRATIONS.slice(0, 11));
    v11.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', ['ab'.repeat(32)]);
    v11.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'takeout', ?, 2)", [ID1, NOW]);
    const add = (album: string, takenAt: string | null) =>
      v11.run("INSERT INTO photo_items (batch_id, sha256, kind, taken_at, source, album, file_name) VALUES (?, ?, 'photo', ?, 'takeout', ?, 'a.jpg')", [ID1, 'ab'.repeat(32), takenAt, album]);
    add('Dated', '2019-07-01T10:00:00Z');
    add('Undated', null);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v11), { expectBlobs: [{ sha256: 'ab'.repeat(32), size: 1 }] })).toEqual({ from: 11, to: SCHEMA_VERSION });
    expect(target.all('SELECT album, date_source FROM photo_items ORDER BY id')).toEqual([
      { album: 'Dated', date_source: 'sidecar' },
      { album: 'Undated', date_source: 'none' },
    ]);

    const source = (await openMemoryDb()).db;
    source.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', ['cd'.repeat(32)]);
    source.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'loose', ?, 1)", [ID1, NOW]);
    source.run("INSERT INTO photo_items (batch_id, sha256, kind, taken_at, date_source, source, album, file_name) VALUES (?, ?, 'photo', ?, 'file-modified', 'loose', '', 'b.jpg')", [ID1, 'cd'.repeat(32), '2020-01-01T00:00:00Z']);
    const restored = (await openMemoryDb()).db;
    await loadSnapshot(restored, serializeDb(source), { expectBlobs: [{ sha256: 'cd'.repeat(32), size: 1 }] });
    expect(restored.all('SELECT source, date_source FROM photo_items')).toEqual([{ source: 'loose', date_source: 'file-modified' }]);
  });

  test('a schema v12 snapshot restores by migrating with no assignments; a v13 snapshot keeps them, replace included', async () => {
    const SHA = 'ab'.repeat(32);
    const v12 = await bareDb(MIGRATIONS.slice(0, 12));
    v12.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', [SHA]);
    v12.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'loose', ?, 1)", [ID1, NOW]);
    v12.run("INSERT INTO photo_items (batch_id, sha256, kind, source, album, file_name) VALUES (?, ?, 'photo', 'loose', '', 'b.jpg')", [ID1, SHA]);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(v12), { expectBlobs: [{ sha256: SHA, size: 1 }] })).toEqual({ from: 12, to: SCHEMA_VERSION });
    expect(target.all('SELECT file_name FROM photo_items')).toEqual([{ file_name: 'b.jpg' }]);
    expect(target.all('SELECT * FROM photo_profiles')).toEqual([]);

    const source = (await openMemoryDb()).db;
    source.run("INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, 'Ana', ?, ?)", [ID2, NOW, NOW]);
    source.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', [SHA]);
    source.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'loose', ?, 1)", [ID1, NOW]);
    source.run("INSERT INTO photo_items (batch_id, sha256, kind, source, album, file_name) VALUES (?, ?, 'photo', 'loose', '', 'b.jpg')", [ID1, SHA]);
    source.run('INSERT INTO photo_profiles (sha256, profile_id, created_at) VALUES (?, ?, ?)', [SHA, ID2, NOW]);
    const restored = (await openMemoryDb()).db;
    await loadSnapshot(restored, serializeDb(source), { expectBlobs: [{ sha256: SHA, size: 1 }] });
    expect(restored.all('SELECT sha256, profile_id FROM photo_profiles')).toEqual([{ sha256: SHA, profile_id: ID2 }]);
    // Replacing a library that has other assignments leaves exactly the snapshot's.
    await loadSnapshot(restored, serializeDb(source), { replace: true, expectBlobs: [{ sha256: SHA, size: 1 }] });
    expect(restored.all('SELECT sha256, profile_id FROM photo_profiles')).toEqual([{ sha256: SHA, profile_id: ID2 }]);
  });

  test('refuses a snapshot that assigns a picture which is not in the collection', async () => {
    const SHA = 'ab'.repeat(32);
    const bad = (await openMemoryDb()).db;
    bad.run("INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, 'Ana', ?, ?)", [ID2, NOW, NOW]);
    bad.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', [SHA]);
    bad.run('INSERT INTO photo_profiles (sha256, profile_id, created_at) VALUES (?, ?, ?)', [SHA, ID2, NOW]);
    const target = (await openMemoryDb()).db;
    await expect(loadSnapshot(target, serializeDb(bad), { expectBlobs: [{ sha256: SHA, size: 1 }] })).rejects.toThrow(/not in the collection/);
  });

  test('refuses a snapshot whose photo date source contradicts its date', async () => {
    for (const [takenAt, source] of [['2020-01-01T00:00:00Z', 'none'], [null, 'exif']] as const) {
      const bad = (await openMemoryDb()).db;
      bad.run('INSERT INTO blobs (sha256, size, mime) VALUES (?, 1, NULL)', ['ab'.repeat(32)]);
      bad.run("INSERT INTO photo_batches (id, source, created_at, added_count) VALUES (?, 'loose', ?, 1)", [ID1, NOW]);
      bad.run("INSERT INTO photo_items (batch_id, sha256, kind, taken_at, date_source, source, album, file_name) VALUES (?, ?, 'photo', ?, ?, 'loose', '', 'b.jpg')", [ID1, 'ab'.repeat(32), takenAt, source]);
      const target = (await openMemoryDb()).db;
      await expect(loadSnapshot(target, serializeDb(bad))).rejects.toThrow(/date source/);
    }
  });

  test('refuses a highlight of an unknown conversation', async () => {
    const orphan = (await openMemoryDb()).db;
    orphan.exec('PRAGMA foreign_keys = OFF');
    orphan.run("INSERT INTO highlights (conversation_id, id, category, title, summary, created_by, created_at, imported_at) VALUES (?, 'h', 'moment', 'T', 'S', 'me', ?, ?)", [ID2, NOW, NOW]);
    await expectInvalid(orphan, /foreign key/);
  });

  test('refuses a note of an unknown conversation or profile', async () => {
    const orphan = (await openMemoryDb()).db;
    orphan.exec('PRAGMA foreign_keys = OFF');
    orphan.run("INSERT INTO notes (kind, conversation_id, body, created_at, updated_at) VALUES ('conversation', ?, 'x', ?, ?)", [ID2, NOW, NOW]);
    await expectInvalid(orphan, /foreign key/);
    const orphanProfile = (await openMemoryDb()).db;
    orphanProfile.exec('PRAGMA foreign_keys = OFF');
    orphanProfile.run("INSERT INTO notes (kind, profile_id, body, created_at, updated_at) VALUES ('profile', ?, 'x', ?, ?)", [ID1, NOW, NOW]);
    await expectInvalid(orphanProfile, /foreign key/);
  });

  test('refuses a malformed note (wrong columns for its kind) as written by a hostile or broken device', async () => {
    const bad = (await openMemoryDb()).db;
    expect(() => bad.run("INSERT INTO notes (kind, body, created_at, updated_at) VALUES ('message', 'x', ?, ?)", [NOW, NOW])).toThrow(/CHECK/);
    // CHECKs can be bypassed by a crafted file: the loader re-inserts every row under the current CHECKs
    const crafted = (await openMemoryDb()).db;
    crafted.exec('PRAGMA ignore_check_constraints = ON');
    crafted.run("INSERT INTO notes (kind, body, created_at, updated_at) VALUES ('message', 'x', ?, ?)", [NOW, NOW]);
    await expectInvalid(crafted, /CHECK|constraint/i);
  });

  test('refuses a favorite of an unknown conversation or with a malformed fingerprint', async () => {
    const orphan = (await openMemoryDb()).db;
    orphan.exec('PRAGMA foreign_keys = OFF');
    orphan.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [ID2, 'ab'.repeat(32), NOW]);
    await expectInvalid(orphan, /foreign key/);
    const bad = (await openMemoryDb()).db;
    expect(() => bad.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [ID2, 'AB'.repeat(32), NOW])).toThrow(/CHECK|FOREIGN/);
  });

  test('refuses a snapshot from a newer schema and leaves the target alone', async () => {
    const newer = await bareDb(NEXT);
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
    const target = await bareDb(NEXT);
    await expectInvalid(source, /triggers, views/, target);
  });

  test('refuses when the target schema is not the snapshot schema after migration', async () => {
    const source = (await openMemoryDb()).db;
    const target = await bareDb(NEXT);
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
    expect(await loadSnapshot(target, serializeDb(source), { expectBlobs: [{ sha256: 'ab'.repeat(32), size: 1 }] })).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
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

describe('loadSnapshot with replace', () => {
  const names = (db: SqlDb) => db.all<{ display_name: string }>('SELECT display_name FROM profiles ORDER BY id').map((r) => r.display_name);

  test('swaps every row of a library that has data, in one transaction', async () => {
    const source = (await openMemoryDb()).db;
    createProfile(source, { id: ID2, displayName: 'Ben', now: NOW });
    const target = (await openMemoryDb()).db;
    profile(target, ID1);
    expect(await loadSnapshot(target, serializeDb(source), { replace: true })).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(names(target)).toEqual(['Ben']);
  });

  test('a snapshot that fails halfway leaves the old library whole', async () => {
    const source = (await openMemoryDb()).db;
    createProfile(source, { id: ID2, displayName: 'Ben', now: NOW });
    source.run('INSERT INTO blobs (sha256, size) VALUES (?, 1)', ['cd'.repeat(32)]);
    const target = (await openMemoryDb()).db;
    profile(target, ID1);
    // The snapshot's media list does not match what the caller expects: refused before anything changes.
    expect(await code(loadSnapshot(target, serializeDb(source), { replace: true, expectBlobs: [] }))).toBe('invalid');
    expect(names(target)).toEqual(['Ana']);
  });

  test('unchangedSince: the swap only happens while the library is exactly what was backed up', async () => {
    const source = (await openMemoryDb()).db;
    createProfile(source, { id: ID2, displayName: 'Ben', now: NOW });
    const target = (await openMemoryDb()).db;
    profile(target, ID1);
    const digest = databaseDigest(serializeDb(target));
    target.run("UPDATE profiles SET description = 'edited later'");
    expect(await code(loadSnapshot(target, serializeDb(source), { replace: true, unchangedSince: digest }))).toBe('changed');
    expect(names(target)).toEqual(['Ana']);
    expect(target.all('SELECT description FROM profiles')).toEqual([{ description: 'edited later' }]);
    const fresh = databaseDigest(serializeDb(target));
    await loadSnapshot(target, serializeDb(source), { replace: true, unchangedSince: fresh });
    expect(names(target)).toEqual(['Ben']);
  });
});

describe('checkSnapshot', () => {
  test('runs the checks and writes nothing', async () => {
    const source = (await openMemoryDb()).db;
    profile(source, ID1);
    const target = (await openMemoryDb()).db;
    expect(await checkSnapshot(target, serializeDb(source))).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(isLibraryEmpty(target)).toBe(true);
    const older = await bareDb(MIGRATIONS.slice(0, 6));
    expect(await checkSnapshot(target, serializeDb(older))).toEqual({ from: 6, to: SCHEMA_VERSION });
    expect(await code(checkSnapshot(target, serializeDb(await bareDb(NEXT))))).toBe('newer-schema');
    expect(await code(checkSnapshot(target, new Uint8Array(10)))).toBe('invalid');
    source.exec('CREATE TRIGGER t AFTER INSERT ON profiles BEGIN SELECT 1; END');
    expect(await code(checkSnapshot(target, serializeDb(source)))).toBe('invalid');
    expect(await code(checkSnapshot(target, serializeDb(source), { expectBlobs: [] }))).toBe('invalid');
  });
});

describe('device identity and sync state across a restore', () => {
  const PEER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  /** A library that has synced: some changes, a peer and a tombstone. */
  async function syncedLibrary() {
    const db = (await openMemoryDb()).db;
    profile(db, ID1);
    createConversation(db, { id: ID2, title: 'Chat', source: 'whatsapp', isGroup: false, profileIds: [ID1], participants: [], now: NOW });
    setNote(db, { target: { kind: 'profile', profileId: ID1 }, body: 'about Ana', now: NOW });
    recordTombstone(db, 'favorite', ID2, 'ab'.repeat(32), NOW);
    recordSent(db, { peerId: PEER, upToSeq: nextChangeSeq(db), now: NOW });
    return db;
  }

  test('a restore on an empty library gives it a NEW device id, no peers, and a counter that continues; records keep their seq', async () => {
    const source = await syncedLibrary();
    const sourceId = getDeviceId(source);
    const counter = source.all<{ n: number }>('SELECT change_seq AS n FROM device')[0].n;
    const target = (await openMemoryDb()).db;
    const targetId = getDeviceId(target); // an identity alone does not make the library non-empty
    expect(isLibraryEmpty(target)).toBe(true);
    await loadSnapshot(target, serializeDb(source));
    const restoredId = getDeviceId(target);
    expect(restoredId).not.toBe(sourceId);
    expect(restoredId).not.toBe(targetId);
    expect(restoredId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(target.all('SELECT * FROM sync_peers')).toEqual([]);
    expect(target.all<{ n: number }>('SELECT change_seq AS n FROM device')).toEqual([{ n: counter }]);
    expect(target.all('SELECT seq FROM profiles ORDER BY id')).toEqual(source.all('SELECT seq FROM profiles ORDER BY id'));
    expect(target.all('SELECT * FROM tombstones')).toEqual(source.all('SELECT * FROM tombstones'));
    expect(target.all('SELECT * FROM notes')).toEqual(source.all('SELECT * FROM notes'));
    // the source is untouched, and its identity and peers stay with it
    expect(getDeviceId(source)).toBe(sourceId);
    expect(source.all('SELECT peer_id FROM sync_peers')).toEqual([{ peer_id: PEER }]);
  });

  test('restoring the same snapshot twice gives two different devices (two machines never share an id)', async () => {
    const source = await syncedLibrary();
    const a = (await openMemoryDb()).db;
    const b = (await openMemoryDb()).db;
    await loadSnapshot(a, serializeDb(source));
    await loadSnapshot(b, serializeDb(source));
    expect(getDeviceId(a)).not.toBe(getDeviceId(b));
  });

  test('replace: the library keeps no trace of its old identity or peers; a failed replace keeps both', async () => {
    const source = await syncedLibrary();
    const target = await syncedLibrary();
    const oldId = getDeviceId(target);
    const oldPeers = target.all('SELECT * FROM sync_peers');
    expect(await code(loadSnapshot(target, serializeDb(source), { replace: true, expectBlobs: [{ sha256: 'ab'.repeat(32), size: 1 }] }))).toBe('invalid');
    expect(getDeviceId(target)).toBe(oldId);
    expect(target.all('SELECT * FROM sync_peers')).toEqual(oldPeers);
    await loadSnapshot(target, serializeDb(source), { replace: true });
    expect(getDeviceId(target)).not.toBe(oldId);
    expect(getDeviceId(target)).not.toBe(getDeviceId(source));
    expect(target.all('SELECT * FROM sync_peers')).toEqual([]);
    // the change counter never moves back below the restored rows
    expect(nextChangeSeq(target)).toBeGreaterThan(Math.max(...target.all<{ seq: number }>('SELECT seq FROM profiles UNION ALL SELECT seq FROM tombstones').map((r) => r.seq)));
  });

  test('a snapshot that never used sync (no device row) restores and gets an identity', async () => {
    const source = await bareDb(MIGRATIONS.slice(0, 7));
    source.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [ID2, 'Chat', 'whatsapp', NOW]);
    const target = (await openMemoryDb()).db;
    expect(await loadSnapshot(target, serializeDb(source))).toEqual({ from: 7, to: SCHEMA_VERSION });
    expect(target.all('SELECT seq FROM conversations')).toEqual([{ seq: 1 }]);
    expect(target.all<{ n: number }>('SELECT change_seq AS n FROM device')).toEqual([{ n: 1 }]);
    expect(getDeviceId(target)).toHaveLength(36);
  });

  test('the restored counter is the real highest change number, not the stored one', async () => {
    const source = await syncedLibrary();
    const highest = Math.max(...source.all<{ seq: number }>('SELECT seq FROM profiles UNION ALL SELECT seq FROM notes UNION ALL SELECT seq FROM tombstones').map((r) => r.seq));
    source.run('UPDATE device SET change_seq = 1'); // doctored: below its own rows
    const target = (await openMemoryDb()).db;
    await loadSnapshot(target, serializeDb(source));
    expect(target.all('SELECT change_seq AS n FROM device')).toEqual([{ n: highest }]);
    expect(nextChangeSeq(target)).toBe(highest + 1);
  });

  test.each([
    ['a huge seq', 'UPDATE profiles SET seq = 4611686018427387904'],
    ['a negative seq', 'UPDATE profiles SET seq = -5'],
    ['a huge counter', 'UPDATE device SET change_seq = 4611686018427387904'],
    ['a huge tombstone seq', 'UPDATE tombstones SET seq = 9007199254740993'],
  ])('%s is refused and the target is untouched', async (_name, doctor) => {
    const source = await syncedLibrary();
    source.exec('PRAGMA ignore_check_constraints = ON');
    source.run(doctor);
    const target = (await openMemoryDb()).db;
    const id = getDeviceId(target);
    await expectInvalid(source, /out of range/, target);
    expect(getDeviceId(target)).toBe(id);
    expect(target.all('SELECT * FROM profiles')).toEqual([]);
  });

  test('a snapshot with a malformed device or peer row is refused and the target is untouched', async () => {
    const source = (await openMemoryDb()).db;
    source.exec('PRAGMA ignore_check_constraints = ON');
    source.run("UPDATE device SET id = 'x'");
    await expectInvalid(source, /./);
  });
});
