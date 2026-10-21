import { describe, expect, test } from 'vitest';
import { DbError } from './errors';
import { MIGRATIONS, migrate, readUserVersion, SCHEMA_VERSION, type Migration } from './migrations';
import { openMemoryDb, openOpfsDb } from './open';
import type { SqlDb } from './sql';

const PROFILE = '3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b';
const CONVERSATION = '7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const BATCH = '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const HASH = 'ab'.repeat(32);

async function rawDb(): Promise<SqlDb> {
  // openMemoryDb already migrates; wipe nothing, just reuse its handle for raw DDL tests.
  return (await openMemoryDb()).db;
}

/** A bare in-memory database with no migrations applied (same engine as production). */
async function emptyDb(): Promise<SqlDb> {
  const { wrapOo1Db } = await import('./sql');
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  return wrapOo1Db(new sqlite3.oo1.DB(':memory:', 'c'));
}

function tables(db: SqlDb): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
}

describe('migrate', () => {
  test('an empty database is brought to the latest version', async () => {
    const db = await emptyDb();
    expect(readUserVersion(db)).toBe(0);
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual([
      'blobs',
      'conversation_profiles',
      'conversations',
      'import_batches',
      'messages',
      'participants',
      'profiles',
    ]);
  });

  test('running it again is a no-op that keeps the data', async () => {
    const db = await emptyDb();
    migrate(db);
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      PROFILE,
      'Ana',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(db.all('SELECT id FROM profiles')).toHaveLength(1);
  });

  test('refuses a database written by a newer version and leaves it untouched', async () => {
    const db = await emptyDb();
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const before = tables(db);
    expect(() => migrate(db)).toThrowError(DbError);
    try {
      migrate(db);
    } catch (error) {
      expect((error as DbError).code).toBe('newer-schema');
    }
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION + 1);
    expect(tables(db)).toEqual(before);
  });

  test('a failing migration rolls back completely and a retry succeeds', async () => {
    const db = await emptyDb();
    migrate(db);
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      PROFILE,
      'Ana',
      't',
      't',
    ]);
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, sql: 'ALTER TABLE profiles ADD COLUMN note TEXT; INSERT INTO missing_table VALUES (1);' },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.all("SELECT name FROM pragma_table_info('profiles') WHERE name = 'note'")).toHaveLength(0);

    const fixed: Migration[] = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, sql: 'ALTER TABLE profiles ADD COLUMN note TEXT;' }];
    expect(migrate(db, fixed)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 1 });
    expect(db.all('SELECT id, note FROM profiles')).toEqual([{ id: PROFILE, note: null }]);
  });

  test('migrates from every earlier version, keeping existing rows', async () => {
    const steps: Migration[] = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, sql: 'ALTER TABLE profiles ADD COLUMN a TEXT;' },
      { version: SCHEMA_VERSION + 2, sql: 'ALTER TABLE profiles ADD COLUMN b TEXT;' },
    ];
    for (let start = 1; start <= steps.length; start++) {
      const db = await emptyDb();
      migrate(db, steps.slice(0, start));
      db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
        PROFILE,
        'Ana',
        't',
        't',
      ]);
      expect(migrate(db, steps)).toEqual({ from: start, to: steps.length });
      expect(db.all<{ display_name: string }>('SELECT display_name FROM profiles')).toEqual([{ display_name: 'Ana' }]);
    }
  });

  test('migrations must be numbered 1..n without gaps', async () => {
    const db = await emptyDb();
    expect(() => migrate(db, [{ version: 2, sql: 'SELECT 1' }])).toThrowError(/numbered/);
    expect(readUserVersion(db)).toBe(0);
  });
});

describe('schema v1 constraints', () => {
  async function seeded() {
    const db = await rawDb();
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [PROFILE, 'Ana', 't', 't']);
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at) VALUES (?, ?, ?, ?)', [BATCH, CONVERSATION, 'whatsapp', 't']);
    return db;
  }
  const insertMessage = (db: SqlDb, over: Record<string, string | number | null> = {}) => {
    const row = {
      conversation_id: CONVERSATION,
      batch_id: BATCH,
      fingerprint: HASH,
      sent_at: '2026-01-01T10:00:00',
      type: 'text',
      media_sha256: null,
      ...over,
    };
    return db.run(
      `INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type, media_sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.conversation_id, row.batch_id, row.fingerprint, row.sent_at, row.type, row.media_sha256],
    );
  };

  test('foreign keys are enforced', async () => {
    const db = await seeded();
    expect(() => insertMessage(db, { conversation_id: '11111111-1111-4111-8111-111111111111' })).toThrow(/FOREIGN KEY/);
    expect(() => insertMessage(db, { media_sha256: HASH })).toThrow(/FOREIGN KEY/);
  });

  test('ids, hashes, timestamps and types are validated by CHECK', async () => {
    const db = await seeded();
    expect(() => db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?,?,?,?)', ['nope', 'x', 't', 't'])).toThrow(/CHECK/);
    expect(() => db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?,?,?,?)', [PROFILE.toUpperCase(), 'x', 't', 't'])).toThrow(/CHECK/);
    expect(() => db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?,?,?,?)', ['11111111-1111-4111-8111-111111111111', '   ', 't', 't'])).toThrow(/CHECK/);
    expect(() => insertMessage(db, { fingerprint: 'XY'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insertMessage(db, { fingerprint: 'ab' })).toThrow(/CHECK/);
    expect(() => insertMessage(db, { sent_at: '2026-01-01 10:00:00' })).toThrow(/CHECK/);
    expect(() => insertMessage(db, { type: 'gif' })).toThrow(/CHECK/);
    expect(() => db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', ['G'.repeat(64), 1])).toThrow(/CHECK/);
    expect(() => db.run('INSERT INTO blobs (sha256, size) VALUES (?, ?)', [HASH, -1])).toThrow(/CHECK/);
  });

  test('the same fingerprint cannot be stored twice in one conversation', async () => {
    const db = await seeded();
    expect(insertMessage(db)).toBe(1);
    expect(() => insertMessage(db)).toThrow(/UNIQUE/);
  });

  test('deleting a profile unlinks its conversations and participants but keeps messages', async () => {
    const db = await seeded();
    db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [CONVERSATION, PROFILE]);
    db.run('INSERT INTO participants (conversation_id, display_name, profile_id) VALUES (?, ?, ?)', [CONVERSATION, 'Ana', PROFILE]);
    insertMessage(db);
    db.run('DELETE FROM profiles WHERE id = ?', [PROFILE]);
    expect(db.all('SELECT * FROM conversation_profiles')).toHaveLength(0);
    expect(db.all<{ profile_id: string | null }>('SELECT profile_id FROM participants')).toEqual([{ profile_id: null }]);
    expect(db.all('SELECT id FROM messages')).toHaveLength(1);
  });

  test('a conversation can belong to several profiles', async () => {
    const db = await seeded();
    const other = '22222222-2222-4222-8222-222222222222';
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?,?,?,?)', [other, 'Bo', 't', 't']);
    db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [CONVERSATION, PROFILE]);
    db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [CONVERSATION, other]);
    expect(() => db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [CONVERSATION, other])).toThrow(/UNIQUE/);
  });
});

describe('import_batches', () => {
  test('deleting a conversation leaves no import batches behind', async () => {
    const db = await rawDb();
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, source_label, created_at) VALUES (?, ?, ?, ?, ?)', [BATCH, CONVERSATION, 'whatsapp', 'Ana.zip', 't']);
    db.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [CONVERSATION, BATCH, HASH, '2026-01-01T10:00:00', 'text']);
    db.run('DELETE FROM conversations WHERE id = ?', [CONVERSATION]);
    expect(db.all('SELECT id FROM import_batches')).toHaveLength(0);
    expect(db.all('SELECT id FROM messages')).toHaveLength(0);
  });
});

describe('openOpfsDb', () => {
  test('without OPFS (Node) it is unavailable, every time, with no stale state', async () => {
    await expect(openOpfsDb()).rejects.toMatchObject({ name: 'DbError', code: 'unavailable' });
    await expect(openOpfsDb()).rejects.toMatchObject({ name: 'DbError', code: 'unavailable' });
  });
});

describe('migration v1 to v2 (profile details)', () => {
  const V1_ONLY = MIGRATIONS.slice(0, 1);
  const HASH2 = 'cd'.repeat(32);

  async function v1WithData() {
    const db = await emptyDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, V1_ONLY);
    db.run('INSERT INTO profiles (id, display_name, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [PROFILE, 'Ana', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [CONVERSATION, PROFILE]);
    return db;
  }

  test('keeps every existing row and gives the new columns their defaults', async () => {
    const db = await v1WithData();
    expect(migrate(db)).toEqual({ from: 1, to: 2 });
    expect(readUserVersion(db)).toBe(2);
    expect(db.all('SELECT * FROM profiles')).toEqual([
      {
        id: PROFILE,
        display_name: 'Ana',
        archived_at: '2026-01-02T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        relationship: '',
        description: '',
        photo_sha256: null,
      },
    ]);
    expect(db.all('SELECT * FROM conversation_profiles')).toHaveLength(1);
  });

  test('photo_sha256 must be a stored blob and valid hex', async () => {
    const db = await v1WithData();
    migrate(db);
    expect(() => db.run('UPDATE profiles SET photo_sha256 = ?', [HASH2])).toThrow(/FOREIGN KEY/);
    expect(() => db.run('UPDATE profiles SET photo_sha256 = ?', ['XY'.repeat(32)])).toThrow(/CHECK/);
    db.run('INSERT INTO blobs (sha256, size) VALUES (?, 1)', [HASH2]);
    expect(db.run('UPDATE profiles SET photo_sha256 = ?', [HASH2])).toBe(1);
  });

  test('a failure in v2 leaves the v1 database as it was', async () => {
    const db = await v1WithData();
    db.run('INSERT INTO blobs (sha256, size) VALUES (?, 1)', [HASH2]);
    const broken: Migration[] = [MIGRATIONS[0], { version: 2, sql: `${MIGRATIONS[1].sql} INSERT INTO missing_table VALUES (1);` }];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(1);
    expect(db.all("SELECT name FROM pragma_table_info('profiles') WHERE name = 'relationship'")).toHaveLength(0);
    expect(migrate(db)).toEqual({ from: 1, to: 2 });
  });
});

describe('frozen schema', () => {
  // Released migrations are never edited: a schema change is a NEW migration.
  // The v1 snapshot below must never change; the latest-schema snapshot is
  // re-pinned only by adding a migration.
  test('schema v1 (released) is unchanged', async () => {
    const db = await emptyDb();
    migrate(db, MIGRATIONS.slice(0, 1));
    const rows = db.all<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
    expect(rows.map((r) => `-- ${r.type} ${r.name}\n${r.sql}`).join('\n')).toMatchInlineSnapshot(`
      "-- index conversation_profiles_by_profile
      CREATE INDEX conversation_profiles_by_profile ON conversation_profiles(profile_id)
      -- index messages_timeline
      CREATE INDEX messages_timeline ON messages(conversation_id, sent_at, ordinal, id)
      -- table blobs
      CREATE TABLE blobs (
        sha256     TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        size       INTEGER NOT NULL CHECK (size >= 0),
        mime       TEXT
      ) STRICT
      -- table conversation_profiles
      CREATE TABLE conversation_profiles (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (conversation_id, profile_id)
      ) STRICT
      -- table conversations
      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
        title      TEXT NOT NULL,
        source     TEXT NOT NULL CHECK (length(source) > 0),
        is_group   INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT
      -- table import_batches
      CREATE TABLE import_batches (
        id            TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
        -- source_label can hold a person's name: it goes away with the conversation.
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source        TEXT NOT NULL CHECK (length(source) > 0),
        source_label  TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        added_count   INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
        skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0)
      ) STRICT
      -- table messages
      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        batch_id        TEXT NOT NULL REFERENCES import_batches(id),
        fingerprint     TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
        sent_at         TEXT NOT NULL CHECK (sent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),
        ordinal         INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
        type            TEXT NOT NULL CHECK (type IN ('text','photo','video','sticker','document','audio','system','deleted','omitted')),
        participant_id  INTEGER REFERENCES participants(id),
        body            TEXT NOT NULL DEFAULT '',
        media_sha256    TEXT REFERENCES blobs(sha256),
        media_name      TEXT NOT NULL DEFAULT '',
        -- The idempotency guarantee: the same message twice is one row.
        UNIQUE (conversation_id, fingerprint)
      ) STRICT
      -- table participants
      CREATE TABLE participants (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        display_name    TEXT NOT NULL,
        profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        UNIQUE (conversation_id, display_name)
      ) STRICT
      -- table profiles
      CREATE TABLE profiles (
        id           TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
        archived_at  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      ) STRICT"
    `);
  });

  test('schema v2 (latest) matches the pinned snapshot, whether created fresh or migrated from v1', async () => {
    const fresh = await emptyDb();
    migrate(fresh);
    const migrated = await emptyDb();
    migrate(migrated, MIGRATIONS.slice(0, 1));
    migrate(migrated);
    const dump = (db: SqlDb) =>
      db
        .all<{ type: string; name: string; sql: string }>(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map((r) => `-- ${r.type} ${r.name}\n${r.sql}`)
        .join('\n');
    expect(dump(migrated)).toBe(dump(fresh));
    expect(dump(fresh).split('-- table profiles')[1]).toMatchInlineSnapshot(`
      "
      CREATE TABLE profiles (
        id           TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
        archived_at  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      , relationship TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', photo_sha256 TEXT REFERENCES blobs(sha256)
        CHECK (photo_sha256 IS NULL OR (length(photo_sha256) = 64 AND photo_sha256 NOT GLOB '*[^0-9a-f]*'))) STRICT"
    `);
  });
});
