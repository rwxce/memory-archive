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
      'favorites',
      'import_batches',
      'messages',
      'notes',
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
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toEqual({ from: 1, to: 2 });
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
    migrate(db, MIGRATIONS.slice(0, 2));
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
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toEqual({ from: 1, to: 2 });
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

  test('schema v2 (released) matches the pinned snapshot, whether created fresh or migrated from v1', async () => {
    const fresh = await emptyDb();
    migrate(fresh, MIGRATIONS.slice(0, 2));
    const migrated = await emptyDb();
    migrate(migrated, MIGRATIONS.slice(0, 1));
    migrate(migrated, MIGRATIONS.slice(0, 2));
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

  test('schema v3 (released) matches the pinned snapshot, whether created fresh or migrated from v2', async () => {
    const V3_ONLY = MIGRATIONS.slice(0, 3);
    const fresh = await emptyDb();
    migrate(fresh, V3_ONLY);
    const migrated = await emptyDb();
    migrate(migrated, MIGRATIONS.slice(0, 1));
    migrate(migrated, MIGRATIONS.slice(0, 2));
    migrate(migrated, V3_ONLY);
    const dump = (db: SqlDb) =>
      db
        .all<{ type: string; name: string; sql: string }>(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map((r) => `-- ${r.type} ${r.name}\n${r.sql}`)
        .join('\n');
    expect(dump(migrated)).toBe(dump(fresh));
    const latest = dump(fresh);
    const pick = (from: string, to: string) => latest.slice(latest.indexOf(from), latest.indexOf(to));
    expect(pick('-- index conversations_by_source_key', '-- index messages_timeline')).toMatchInlineSnapshot(`
      "-- index conversations_by_source_key
      CREATE INDEX conversations_by_source_key ON conversations(source, source_key) WHERE source_key <> ''
      -- index messages_by_batch
      CREATE INDEX messages_by_batch ON messages(batch_id)
      -- index messages_by_media
      CREATE INDEX messages_by_media ON messages(media_sha256) WHERE media_sha256 IS NOT NULL
      "
    `);
    expect(pick('-- table conversations', '-- table messages')).toMatchInlineSnapshot(`
      "-- table conversations
      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
        title      TEXT NOT NULL,
        source     TEXT NOT NULL CHECK (length(source) > 0),
        is_group   INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
        created_at TEXT NOT NULL
      , source_key TEXT NOT NULL DEFAULT '') STRICT
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
      , created_conversation INTEGER NOT NULL DEFAULT 0 CHECK (created_conversation IN (0, 1))) STRICT
      "
    `);
    expect(latest.slice(latest.indexOf('-- table participants'), latest.indexOf('-- table profiles'))).toMatchInlineSnapshot(`
      "-- table participants
      CREATE TABLE participants (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        display_name    TEXT NOT NULL,
        profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL, is_me INTEGER NOT NULL DEFAULT 0 CHECK (is_me IN (0, 1)),
        UNIQUE (conversation_id, display_name)
      ) STRICT
      "
    `);
  });
});

describe('migration v2 to v3 (incremental import)', () => {
  async function v2WithData() {
    const db = await emptyDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 2));
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO participants (conversation_id, display_name) VALUES (?, ?)', [CONVERSATION, 'Ana']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 1)', [BATCH, CONVERSATION, 'whatsapp', 't']);
    db.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [CONVERSATION, BATCH, HASH, '2026-01-01T10:00:00', 'text']);
    return db;
  }

  test('keeps every existing row and gives the new columns their defaults', async () => {
    const db = await v2WithData();
    expect(migrate(db, MIGRATIONS.slice(0, 3))).toEqual({ from: 2, to: 3 });
    expect(readUserVersion(db)).toBe(3);
    expect(db.all('SELECT title, source_key FROM conversations')).toEqual([{ title: 'Chat', source_key: '' }]);
    expect(db.all('SELECT display_name, is_me FROM participants')).toEqual([{ display_name: 'Ana', is_me: 0 }]);
    expect(db.all('SELECT added_count, created_conversation FROM import_batches')).toEqual([{ added_count: 1, created_conversation: 0 }]);
    expect(db.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: HASH }]);
  });

  test('the new flags only accept 0 and 1', async () => {
    const db = await v2WithData();
    migrate(db, MIGRATIONS.slice(0, 3));
    expect(() => db.run('UPDATE participants SET is_me = 2')).toThrow(/CHECK/);
    expect(() => db.run('UPDATE import_batches SET created_conversation = 2')).toThrow(/CHECK/);
  });

  test('a failure in v3 leaves the v2 database as it was, and a retry succeeds', async () => {
    const db = await v2WithData();
    const broken: Migration[] = [...MIGRATIONS.slice(0, 2), { version: 3, sql: `${MIGRATIONS[2].sql} INSERT INTO missing_table VALUES (1);` }];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(2);
    expect(db.all("SELECT name FROM pragma_table_info('conversations') WHERE name = 'source_key'")).toHaveLength(0);
    expect(migrate(db, MIGRATIONS.slice(0, 3))).toEqual({ from: 2, to: 3 });
  });
});

describe('migration v3 to v4 (person timeline index)', () => {
  async function v3WithData() {
    const db = await emptyDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 3));
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 1)', [BATCH, CONVERSATION, 'whatsapp', 't']);
    db.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [CONVERSATION, BATCH, HASH, '2026-01-01T10:00:00', 'text']);
    return db;
  }

  test('adds only the index: tables, columns and rows are untouched, and the schema is the same fresh or migrated', async () => {
    const db = await v3WithData();
    const tables = () => db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const before = tables();
    expect(migrate(db, MIGRATIONS.slice(0, 4))).toEqual({ from: 3, to: 4 });
    expect(readUserVersion(db)).toBe(4);
    expect(tables()).toEqual(before);
    expect(db.all('SELECT fingerprint, sent_at FROM messages')).toEqual([{ fingerprint: HASH, sent_at: '2026-01-01T10:00:00' }]);
    expect(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'messages_by_time'")).toEqual([
      { sql: 'CREATE INDEX messages_by_time ON messages(sent_at, ordinal, conversation_id)' },
    ]);
    const fresh = await emptyDb();
    migrate(fresh, MIGRATIONS.slice(0, 4));
    const dump = (d: SqlDb) => d.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(dump(db)).toEqual(dump(fresh));
  });

  test('a failure in v4 leaves the v3 database as it was, and a retry succeeds', async () => {
    const db = await v3WithData();
    const broken: Migration[] = [...MIGRATIONS.slice(0, 3), { version: 4, sql: `${MIGRATIONS[3].sql} INSERT INTO missing_table VALUES (1);` }];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(3);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'messages_by_time'")).toHaveLength(0);
    expect(migrate(db, MIGRATIONS.slice(0, 4))).toEqual({ from: 3, to: 4 });
  });
});

describe('migration v4 to v5 (favorites)', () => {
  async function v4WithData() {
    const db = await emptyDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 4));
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 1)', [BATCH, CONVERSATION, 'whatsapp', 't']);
    db.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [CONVERSATION, BATCH, HASH, '2026-01-01T10:00:00', 'text']);
    return db;
  }

  test('adds only the favorites table: existing tables and rows are untouched, and the schema is the same fresh or migrated', async () => {
    const db = await v4WithData();
    const before = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(migrate(db, MIGRATIONS.slice(0, 5))).toEqual({ from: 4, to: 5 });
    expect(readUserVersion(db)).toBe(5);
    const after = db.all<{ name: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(after.filter((t) => t.name !== 'favorites')).toEqual(before);
    expect(db.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: HASH }]);
    expect(db.all('SELECT * FROM favorites')).toEqual([]);
    const fresh = await emptyDb();
    migrate(fresh, MIGRATIONS.slice(0, 5));
    const dump = (d: SqlDb) => d.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(dump(db)).toEqual(dump(fresh));
  });

  test('schema of the favorites table is pinned (keyed by conversation and fingerprint, no link to messages)', async () => {
    const db = await emptyDb();
    migrate(db, MIGRATIONS.slice(0, 5));
    expect(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'favorites'")[0].sql).toMatchInlineSnapshot(`
      "CREATE TABLE favorites (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        fingerprint     TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
        created_at      TEXT NOT NULL,
        PRIMARY KEY (conversation_id, fingerprint)
      ) STRICT"
    `);
  });

  test('one row per message, a malformed fingerprint is refused and a favorite goes with its conversation', async () => {
    const db = await v4WithData();
    migrate(db, MIGRATIONS.slice(0, 5));
    const add = (fp: string) => db.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [CONVERSATION, fp, 't']);
    add(HASH);
    expect(() => add(HASH)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => add('AB'.repeat(32))).toThrow(/CHECK/);
    expect(() => add('ab')).toThrow(/CHECK/);
    expect(() => db.run('INSERT INTO favorites VALUES (?, ?, ?)', [PROFILE, HASH, 't'])).toThrow(/FOREIGN/);
    db.run('DELETE FROM messages');
    expect(db.all('SELECT fingerprint FROM favorites')).toEqual([{ fingerprint: HASH }]);
    db.run('DELETE FROM import_batches');
    db.run('DELETE FROM conversations');
    expect(db.all('SELECT * FROM favorites')).toEqual([]);
  });

  test('a failure in v5 leaves the v4 database as it was, and a retry succeeds', async () => {
    const db = await v4WithData();
    const broken: Migration[] = [...MIGRATIONS.slice(0, 4), { version: 5, sql: `${MIGRATIONS[4].sql} INSERT INTO missing_table VALUES (1);` }];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(4);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'favorites'")).toHaveLength(0);
    expect(migrate(db, MIGRATIONS.slice(0, 5))).toEqual({ from: 4, to: 5 });
  });
});

describe('migration v5 to v6 (notes)', () => {
  const FP2 = 'cd'.repeat(32);
  async function v5WithData() {
    const db = await emptyDb();
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 5));
    db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [PROFILE, 'Ana', 't', 't']);
    db.run('INSERT INTO conversations (id, title, source, created_at) VALUES (?, ?, ?, ?)', [CONVERSATION, 'Chat', 'whatsapp', 't']);
    db.run('INSERT INTO import_batches (id, conversation_id, source, created_at, added_count) VALUES (?, ?, ?, ?, 1)', [BATCH, CONVERSATION, 'whatsapp', 't']);
    db.run('INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, type) VALUES (?, ?, ?, ?, ?)', [CONVERSATION, BATCH, HASH, '2026-01-01T10:00:00', 'text']);
    db.run('INSERT INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [CONVERSATION, HASH, 't']);
    return db;
  }

  test('adds only the notes table: existing tables and rows are untouched, and the schema is the same fresh or migrated', async () => {
    const db = await v5WithData();
    const before = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(migrate(db)).toEqual({ from: 5, to: 6 });
    expect(readUserVersion(db)).toBe(6);
    const after = db.all<{ name: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(after.filter((t) => t.name !== 'notes')).toEqual(before);
    expect(db.all('SELECT fingerprint FROM messages')).toEqual([{ fingerprint: HASH }]);
    expect(db.all('SELECT fingerprint FROM favorites')).toEqual([{ fingerprint: HASH }]);
    expect(db.all('SELECT * FROM notes')).toEqual([]);
    const fresh = await emptyDb();
    migrate(fresh);
    const dump = (d: SqlDb) => d.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    expect(dump(db)).toEqual(dump(fresh));
  });

  test('schema of the notes table is pinned (real keys, kind-checked columns, one note per target, no link to messages)', async () => {
    const db = await emptyDb();
    migrate(db);
    expect(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'notes'")[0].sql).toMatchInlineSnapshot(`
      "CREATE TABLE notes (
        kind            TEXT NOT NULL CHECK (kind IN ('profile', 'conversation', 'message')),
        profile_id      TEXT REFERENCES profiles(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        fingerprint     TEXT CHECK (fingerprint IS NULL OR (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
        body            TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        CHECK (
          (kind = 'profile' AND profile_id IS NOT NULL AND conversation_id IS NULL AND fingerprint IS NULL) OR
          (kind = 'conversation' AND profile_id IS NULL AND conversation_id IS NOT NULL AND fingerprint IS NULL) OR
          (kind = 'message' AND profile_id IS NULL AND conversation_id IS NOT NULL AND fingerprint IS NOT NULL)
        )
      ) STRICT"
    `);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' ORDER BY name")).toEqual([
      { name: 'notes_one_per_conversation' },
      { name: 'notes_one_per_message' },
      { name: 'notes_one_per_profile' },
    ]);
  });

  test('each kind needs exactly its columns, and there is one note per target', async () => {
    const db = await v5WithData();
    migrate(db);
    const add = (kind: string, profile: string | null, conversation: string | null, fp: string | null) =>
      db.run('INSERT INTO notes (kind, profile_id, conversation_id, fingerprint, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, profile, conversation, fp, 'text', 't', 't']);
    add('profile', PROFILE, null, null);
    add('conversation', null, CONVERSATION, null);
    add('message', null, CONVERSATION, HASH);
    add('message', null, CONVERSATION, FP2); // a message note whose message does not exist: dormant, allowed
    expect(() => add('profile', PROFILE, null, null)).toThrow(/UNIQUE/);
    expect(() => add('conversation', null, CONVERSATION, null)).toThrow(/UNIQUE/);
    expect(() => add('message', null, CONVERSATION, HASH)).toThrow(/UNIQUE/);
    // wrong columns for the kind
    expect(() => add('profile', null, CONVERSATION, null)).toThrow(/CHECK/);
    expect(() => add('profile', PROFILE, CONVERSATION, null)).toThrow(/CHECK/);
    expect(() => add('conversation', PROFILE, CONVERSATION, null)).toThrow(/CHECK/);
    expect(() => add('conversation', null, CONVERSATION, HASH)).toThrow(/CHECK|UNIQUE/);
    expect(() => add('message', null, CONVERSATION, null)).toThrow(/CHECK/);
    expect(() => add('message', PROFILE, CONVERSATION, HASH)).toThrow(/CHECK/);
    expect(() => add('other', PROFILE, null, null)).toThrow(/CHECK/);
    // malformed fingerprint, unknown targets
    expect(() => add('message', null, CONVERSATION, 'AB'.repeat(32))).toThrow(/CHECK/);
    expect(() => add('message', null, CONVERSATION, 'ab')).toThrow(/CHECK/);
    expect(() => add('profile', BATCH, null, null)).toThrow(/FOREIGN/);
    expect(() => add('conversation', null, BATCH, null)).toThrow(/FOREIGN/);
    expect(() => db.run("INSERT INTO notes VALUES ('profile', ?, NULL, NULL, NULL, 't', 't')", [PROFILE])).toThrow(/NOT NULL|UNIQUE/);
  });

  test('a message note outlives its message and goes with its conversation; a profile note goes with its profile', async () => {
    const db = await v5WithData();
    migrate(db);
    db.run("INSERT INTO notes (kind, conversation_id, fingerprint, body, created_at, updated_at) VALUES ('message', ?, ?, 'x', 't', 't')", [CONVERSATION, HASH]);
    db.run("INSERT INTO notes (kind, conversation_id, body, created_at, updated_at) VALUES ('conversation', ?, 'x', 't', 't')", [CONVERSATION]);
    db.run("INSERT INTO notes (kind, profile_id, body, created_at, updated_at) VALUES ('profile', ?, 'x', 't', 't')", [PROFILE]);
    db.run('DELETE FROM messages');
    expect(db.all('SELECT kind FROM notes ORDER BY kind')).toHaveLength(3);
    db.run('DELETE FROM favorites');
    db.run('DELETE FROM import_batches');
    db.run('DELETE FROM conversations');
    expect(db.all('SELECT kind FROM notes')).toEqual([{ kind: 'profile' }]);
    db.run('DELETE FROM profiles');
    expect(db.all('SELECT * FROM notes')).toEqual([]);
  });

  test('a failure in v6 leaves the v5 database as it was, and a retry succeeds', async () => {
    const db = await v5WithData();
    const broken: Migration[] = [...MIGRATIONS.slice(0, 5), { version: 6, sql: `${MIGRATIONS[5].sql} INSERT INTO missing_table VALUES (1);` }];
    expect(() => migrate(db, broken)).toThrow();
    expect(readUserVersion(db)).toBe(5);
    expect(db.all("SELECT name FROM sqlite_master WHERE name LIKE 'notes%'")).toHaveLength(0);
    expect(migrate(db)).toEqual({ from: 5, to: 6 });
  });
});
