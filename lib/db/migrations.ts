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

/**
 * v6 (expand only): notes, one editable text per profile, conversation or message. A new table
 * only: no existing column, row or index changes, so a v1-v5 backup restores by migrating (the
 * table starts empty). Notes are personal text: they live in the snapshot, hence in every backup.
 *
 * One table with a `kind` and the real target columns (not a generic `target_key` string), so the
 * foreign keys are real: `profile_id` and `conversation_id` are `ON DELETE CASCADE` (a note goes
 * with its conversation, like favorites; profiles are archived, never deleted, so that cascade
 * only guards the invariant). A message note is anchored like a favorite, by
 * `(conversation_id, fingerprint)`, never by the local message id, and has NO foreign key to
 * `messages`: undoing an import and importing again must not lose the note; a note whose message
 * is gone is dormant (no read returns it) and comes back with the message.
 *
 * The CHECK ties each kind to exactly its columns. One note per target is guaranteed by unique
 * indexes (NULLs are distinct, so a kind never collides with another): `profile_id`;
 * `(conversation_id, fingerprint)` for messages, which also serves the cascade and the window
 * join; `conversation_id` only for the conversation kind. An empty note is never stored (saving
 * an empty text deletes the row) and the text bound lives in the application
 * (`domain/profile.ts`), not in a CHECK. `created_at` / `updated_at` are UTC instants from the
 * caller; `created_at` is kept when the text is edited.
 */
const V6 = `
CREATE TABLE notes (
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
) STRICT;
CREATE UNIQUE INDEX notes_one_per_profile ON notes(profile_id);
CREATE UNIQUE INDEX notes_one_per_message ON notes(conversation_id, fingerprint);
CREATE UNIQUE INDEX notes_one_per_conversation ON notes(conversation_id) WHERE kind = 'conversation';
`;

/**
 * v7 (expand only): highlights, the key moments / patterns / messages of interest a person imports
 * from a `findings.json` (`domain/highlights.ts`). Two new tables only: no existing column, row or
 * index changes, so a v1-v6 backup restores by migrating (the tables start empty). Highlights are
 * personal text: they live in the snapshot, hence in every backup.
 *
 * A highlight belongs to one conversation and is keyed by the id its author gave it, so importing
 * the same file again updates in place instead of duplicating. Its messages are anchored like
 * favorites and notes, by `(conversation_id, fingerprint)`, never by the local message id, and have
 * NO foreign key to `messages`: undoing an import and importing again must not lose them; a message
 * that is gone is dormant (reads join `messages`) and comes back with it. Only fingerprints that
 * were in the conversation when the file was imported are stored. Both tables go with their
 * conversation (`ON DELETE CASCADE`); `highlight_messages` also goes with its highlight.
 *
 * `created_at` is the instant the author wrote in the file, `imported_at` the instant it was
 * imported (UTC, supplied by the caller). `position` keeps the author's order of the messages.
 * Text bounds live in the application (`FINDINGS_LIMITS`), not in CHECKs.
 */
const V7 = `
CREATE TABLE highlights (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  id              TEXT NOT NULL CHECK (length(id) > 0),
  category        TEXT NOT NULL CHECK (category IN ('moment', 'pattern', 'interest')),
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  imported_at     TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id)
) STRICT;

CREATE TABLE highlight_messages (
  conversation_id TEXT NOT NULL,
  highlight_id    TEXT NOT NULL,
  fingerprint     TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  position        INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (conversation_id, highlight_id, fingerprint),
  FOREIGN KEY (conversation_id, highlight_id) REFERENCES highlights(conversation_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX highlight_messages_by_message ON highlight_messages(conversation_id, fingerprint);
`;

/**
 * v8 (expand only): what manual device-to-device sync needs (`docs/formats/changes-pack.md`). New
 * tables and columns only, all with defaults: no row changes meaning, so a v1-v7 backup restores
 * by migrating.
 *
 * - `device`: this library's identity (id, creation instant) and a monotonic change counter. The
 *   migration creates the row (random id, counter 1) so the database file never changes later just
 *   because something asked for the id (the replace digest check depends on that). A restored
 *   database never keeps the id it was backed up with: a restore is a different device
 *   (`renewDevice`), and the row copied from a snapshot is ignored.
 * - `seq` on the records a pack carries (profiles, conversations, import batches, favorites,
 *   notes): the counter value at their last change here. Existing rows get the baseline 1 (the
 *   counter's first value), so "everything since 0" is the whole library and every later change
 *   gets a number above it. Deterministic: no clock, no ordering. Messages have no `seq`: they are
 *   immutable and travel with their import batch. Highlights are not synced (in a full backup only).
 * - `changed_by` (profiles, conversations, notes, favorites, tombstones): the peer device whose version this row holds;
 *   NULL = made here. It stops a version just merged from a peer from counting as a local edit
 *   against that same peer (a false conflict).
 * - `tombstones`: deleted favorites, notes and import batches, so the deletion can travel.
 * - `sync_peers`: per peer device, the watermarks sent to and received from it.
 */
const V8 = `
CREATE TABLE device (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  id         TEXT NOT NULL CHECK (length(id) = 36 AND id = lower(id)),
  created_at TEXT NOT NULL,
  change_seq INTEGER NOT NULL CHECK (change_seq >= 1)
) STRICT;

CREATE TABLE sync_peers (
  peer_id           TEXT PRIMARY KEY CHECK (length(peer_id) = 36 AND peer_id = lower(peer_id)),
  last_sent_seq     INTEGER NOT NULL DEFAULT 0 CHECK (last_sent_seq >= 0),
  last_sent_at      TEXT,
  last_received_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_received_seq >= 0),
  last_received_at  TEXT
) STRICT;

-- scope: the conversation id ('' for a person's note); key: favorite = message fingerprint,
-- note = 'profile:<id>' | 'conversation' | 'message:<fingerprint>', batch = batch id.
CREATE TABLE tombstones (
  kind       TEXT NOT NULL CHECK (kind IN ('favorite', 'note', 'batch')),
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by))),
  PRIMARY KEY (kind, scope, key)
) STRICT;
CREATE INDEX tombstones_by_seq ON tombstones(seq);

ALTER TABLE profiles ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by)));
ALTER TABLE conversations ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by)));
ALTER TABLE notes ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by)));
ALTER TABLE import_batches ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE favorites ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE favorites ADD COLUMN changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by)));

UPDATE profiles SET seq = 1;
UPDATE conversations SET seq = 1;
UPDATE notes SET seq = 1;
UPDATE import_batches SET seq = 1;
UPDATE favorites SET seq = 1;

INSERT INTO device (singleton, id, created_at, change_seq) VALUES (1,
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);

CREATE INDEX favorites_by_seq ON favorites(seq);
CREATE INDEX notes_by_seq ON notes(seq);
`;

/**
 * v9 (expand only): the open conflicts of a changes-pack merge (`docs/formats/changes-pack.md`,
 * "Conflicts"). One new table, empty at first: no existing column or row changes, so a v1-v8
 * backup restores by migrating. Added with its first entry point, the merge.
 *
 * A row keeps the INCOMING version (or incoming deletion) beside the active local record, which
 * the merge never touches; the user later picks mine / theirs / both. `kind` `batch` is not a
 * conflict but the offer "the other device undid this import; remove it here too?": nothing is
 * applied until the user accepts. `scope` / `key` name the record like `tombstones` do (profile and
 * conversation: scope '' and the id; note: as the note tombstone; batch: conversation id and batch
 * id). `incoming` is the pack's JSON record (a tombstone when `incoming_deleted` is 1). One open
 * row per peer and record: a newer incoming version replaces the older. It describes this device's
 * exchange with a peer, so, like `sync_peers`, a restore does not carry it over.
 */
const V9 = `
CREATE TABLE sync_conflicts (
  id               INTEGER PRIMARY KEY,
  peer_id          TEXT NOT NULL CHECK (length(peer_id) = 36 AND peer_id = lower(peer_id)),
  kind             TEXT NOT NULL CHECK (kind IN ('profile', 'conversation', 'note', 'batch')),
  scope            TEXT NOT NULL,
  key              TEXT NOT NULL,
  incoming         TEXT NOT NULL,
  incoming_deleted INTEGER NOT NULL DEFAULT 0 CHECK (incoming_deleted IN (0, 1)),
  detected_at      TEXT NOT NULL,
  UNIQUE (peer_id, kind, scope, key)
) STRICT;
`;

/**
 * v10 (expand only): `import_batches.changed_by`, the device a batch was merged from (NULL = made
 * here). Like the other synced tables, it lets a changes pack and the unsent count skip handing a
 * batch back to the device it came from; a third device still gets it relayed. Existing rows stay
 * NULL, which is exactly the old behaviour (every batch above the watermark is carried), so a
 * v1-v9 backup restores by migrating and no row changes.
 */
const V10 = `
ALTER TABLE import_batches ADD COLUMN changed_by TEXT CHECK (changed_by IS NULL OR (length(changed_by) = 36 AND changed_by = lower(changed_by)));
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
  { version: 7, sql: V7 },
  { version: 8, sql: V8 },
  { version: 9, sql: V9 },
  { version: 10, sql: V10 },
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
