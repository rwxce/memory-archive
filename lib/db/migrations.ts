import { DbError } from './errors';
import { transaction, type SqlDb } from './sql';

/**
 * Forward-only schema migrations, versioned with `PRAGMA user_version`.
 *
 * Rules (docs/blueprint.md, "Schema and migrations"):
 * - a released migration is never edited; schema changes are new entries;
 * - each migration runs in one transaction together with its version bump, so
 *   a failure leaves the database exactly as it was and a retry is safe;
 * - expand / migrate / contract: nothing here drops user data; a destructive
 *   step needs an explicit backup-first path in a later release;
 * - a database with a newer `user_version` than this build knows is refused.
 */
export interface Migration {
  version: number;
  sql: string;
}

/**
 * v1: profiles, conversations (many-to-many with profiles, explicit
 * participants), messages deduplicated by fingerprint, content-addressed media
 * references and import batches.
 *
 * Timestamps: `sent_at` is the local wall-clock time of the message
 * (`YYYY-MM-DDTHH:MM:SS`, no zone); `created_at`/`updated_at`/`archived_at`
 * are UTC instants supplied by the caller.
 */
const V1 = `
CREATE TABLE profiles (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  archived_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  title      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (length(source) > 0),
  is_group   INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

-- A conversation can belong to several profiles and a profile has several
-- conversations. Moving a conversation edits these rows, never the messages.
CREATE TABLE conversation_profiles (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, profile_id)
) STRICT;
CREATE INDEX conversation_profiles_by_profile ON conversation_profiles(profile_id);

-- Who wrote in a conversation, as named by the source. The profile link is
-- explicit and optional; a group is never assumed to be one person.
CREATE TABLE participants (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (conversation_id, display_name)
) STRICT;

-- Media is stored once, by the SHA-256 of its bytes (the bytes live in OPFS).
CREATE TABLE blobs (
  sha256     TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size       INTEGER NOT NULL CHECK (size >= 0),
  mime       TEXT
) STRICT;

CREATE TABLE import_batches (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36 AND id = lower(id)),
  -- source_label can hold a person's name: it goes away with the conversation.
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (length(source) > 0),
  source_label  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  added_count   INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0)
) STRICT;

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
) STRICT;
CREATE INDEX messages_timeline ON messages(conversation_id, sent_at, ordinal, id);
`;

/**
 * v2 (expand only): the profile details of Phase 3. Every column is added with
 * a default, so existing rows stay valid and a v1 backup restores by migrating.
 *
 * `photo_sha256` references `blobs`: the photo is an ordinary content-addressed
 * media blob (bytes in OPFS), so a profile can never point at a hash the
 * library does not know, and the same photo is stored once. Nothing deletes
 * blobs, and profiles are archived, never deleted, so the reference cannot
 * dangle. Length bounds are enforced by the application (`domain/profile.ts`),
 * not by CHECK, so they can change without a migration.
 */
const V2 = `
ALTER TABLE profiles ADD COLUMN relationship TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN photo_sha256 TEXT REFERENCES blobs(sha256)
  CHECK (photo_sha256 IS NULL OR (length(photo_sha256) = 64 AND photo_sha256 NOT GLOB '*[^0-9a-f]*'));
`;

/**
 * v3 (expand only): what incremental import and undo need. Every column has a default, so a
 * v1 or v2 backup restores by migrating and nothing existing changes meaning.
 *
 * - `conversations.source_key`: the importer's stable key for "the same chat" (a normalized
 *   chat title, see `chatKeyOf`), kept apart from `title` because the user may rename a
 *   conversation. '' = no key (never matched by an import).
 * - `participants.is_me`: the author the user said is themselves (set by an import).
 * - `import_batches.created_conversation`: this batch created its conversation, so undoing it
 *   removes the conversation too once it is empty.
 * - indexes: undo finds a batch's messages and a blob's referrers without scanning.
 */
const V3 = `
ALTER TABLE conversations ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
ALTER TABLE participants ADD COLUMN is_me INTEGER NOT NULL DEFAULT 0 CHECK (is_me IN (0, 1));
ALTER TABLE import_batches ADD COLUMN created_conversation INTEGER NOT NULL DEFAULT 0 CHECK (created_conversation IN (0, 1));
CREATE INDEX conversations_by_source_key ON conversations(source, source_key) WHERE source_key <> '';
CREATE INDEX messages_by_batch ON messages(batch_id);
CREATE INDEX messages_by_media ON messages(media_sha256) WHERE media_sha256 IS NOT NULL;
`;

/**
 * v4 (expand only): the index behind a person's combined timeline (messages of every conversation
 * linked to a person, merged by time). Adds an index only: no column, no row, nothing changes
 * meaning, so a v1-v3 backup restores by migrating (the index is built once, a moment per 100k rows).
 *
 * Key `(sent_at, ordinal, conversation_id)` (the rowid `id` is the implicit last key): it is exactly
 * the timeline's total order `(sent_at, ordinal, conversation_id, id)`, so the window walks it in
 * order with no sort, and it is covering for the membership test (`conversation_id IN (...)`), so
 * the OFFSET skip never touches the table. On 200k messages over 3 of 4 conversations this was
 * 16 ms at the far end, against 31 ms for `(sent_at, id)` and 60 ms for the planner's default
 * (every linked conversation through `messages_timeline`, then one sort of all of them).
 * The planner does not choose it by itself (it prefers the sort), so the query names it.
 */
const V4 = `
CREATE INDEX messages_by_time ON messages(sent_at, ordinal, conversation_id);
`;

/**
 * v5 (expand only): favorite messages. A new table only: no existing column, row or index changes,
 * so a v1-v4 backup restores by migrating (the table starts empty).
 *
 * A favorite is anchored by `(conversation_id, fingerprint)`, never by the local integer message id:
 * the id is per device, the fingerprint is the message's identity in a backup and in the future
 * device sync, so a favorite survives restore and merge. Media favorites are favorite messages that
 * carry media (a media message is a message).
 *
 * Deliberately NO foreign key to `messages`: undoing an import and importing the same chat again
 * must not lose the favorite. A favorite whose message is gone is dormant: no read returns it (they
 * all join `messages`) and it reappears with the message. It is removed only with its conversation
 * (`ON DELETE CASCADE`, like the other per-conversation rows). `created_at` is a UTC instant
 * supplied by the caller, like `profiles.created_at`.
 */
const V5 = `
CREATE TABLE favorites (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, fingerprint)
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
];

/** Schema version this build produces and understands. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function readUserVersion(db: SqlDb): number {
  const [row] = db.all<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Brings the database to the latest schema. Safe to call on every open:
 * already-applied migrations are skipped. Throws `newer-schema` (touching
 * nothing) when the database comes from a newer app version.
 */
export function migrate(
  db: SqlDb,
  migrations: readonly Migration[] = MIGRATIONS,
): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new DbError('internal', `migrations must be numbered 1..n (got ${m.version} at ${i})`);
  });
  const latest = migrations.length;
  const from = readUserVersion(db);
  if (from > latest) {
    throw new DbError(
      'newer-schema',
      `database schema v${from} is newer than this app understands (v${latest}); update the app`,
    );
  }
  for (const m of migrations.slice(from)) {
    transaction(db, () => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: latest };
}
