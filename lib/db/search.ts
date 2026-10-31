import type { SearchIndexStep, SearchResult, SearchStatus } from '../domain/library';
import { snippetOf, toMatchExpression } from '../domain/search-query';
import { DbError } from './errors';
import { MAX_WINDOW, requireConversation, requireProfile, toWindowMessage, type WindowRow } from './queries';
import type { SqlDb, SqlValue } from './sql';

/**
 * Full-text search over message text: a DERIVED, rebuildable index in a SEPARATE database file
 * (`search`), attached to the library connection only while an operation uses it. Nothing here
 * changes the library schema, and nothing of it can reach a backup: the backup serializes
 * `main`, and `snapshot.ts` refuses virtual tables in anything restored.
 *
 * The index holds, per message id, the searchable text (`body` and the media file name) and the
 * first 16 hex digits of the message fingerprint. A row is only trusted while the message with
 * that id still has that fingerprint (ids can be reused after an undo), so a stale index can miss
 * new messages but never shows another message's text.
 *
 * Staleness without triggers: this connection's `total_changes()` counts every row the library
 * changed (import, undo, restore, favorites, ...). After a full pass that saw no outside change the
 * count is remembered; any later difference means "stale" and the next pass reconciles by id
 * ranges (adds what is missing, removes what is gone or different). A new process remembers
 * nothing, so the first search after opening always verifies once. A pass is chunked
 * (`stepSearchIndex`) so the worker stays responsive and the page can show progress.
 */

/** Version of the index layout; a different value in the file drops and recreates the index (it is only a cache). */
export const SEARCH_INDEX_VERSION = 1;
export const SEARCH_DEFAULT_STEP = 5000;
const MIN_STEP = 100;
const MAX_STEP = 20_000;

/**
 * Where the index database lives, registered once per library connection (`openMemoryDb`,
 * `openOpfsDb`): a file name in the OPFS pool or `:memory:` (Node tests), whether the file
 * already exists (so removing messages costs nothing when no index was ever made), and a way to
 * delete a damaged file.
 */
export interface SearchTarget {
  file: string;
  exists: boolean;
  /** Deletes the file (OPFS); absent in memory, where re-attaching gives an empty database. */
  remove?: () => void;
}

interface PassState {
  target: SearchTarget;
  attached: boolean;
  /** Last message id handled by the pass in progress (`PASS_START` = not started). */
  cursor: number;
  /** `total_changes()` right after our last write; a different value at the next step means someone else wrote. */
  lastSeen: number | null;
  /** Someone else wrote since this pass began. */
  foreign: boolean;
  /** `total_changes()` when a clean pass finished; the index is `ready` while it still matches. */
  verifiedAt: number | null;
  /** A discard failed half way: the file may still hold text, reset it before the next use. */
  resetNeeded: boolean;
}

/** Below every possible message id (they may be negative in a hostile snapshot). */
const PASS_START = Number.MIN_SAFE_INTEGER;

const states = new WeakMap<SqlDb, PassState>();

function stateOf(db: SqlDb): PassState {
  let s = states.get(db);
  if (!s) {
    s = { target: { file: ':memory:', exists: false }, attached: false, cursor: PASS_START, lastSeen: null, foreign: false, verifiedAt: null, resetNeeded: false };
    states.set(db, s);
  }
  return s;
}

/** Tells this module where the connection's index lives. Called by the `open*Db` functions. */
export function registerSearchTarget(db: SqlDb, target: SearchTarget): void {
  stateOf(db).target = target;
}

const totalChanges = (db: SqlDb) => db.all<{ n: number }>('SELECT total_changes() AS n')[0].n;

const unavailable = (message: string) => new DbError('unavailable', message);

const forgetPass = (state: PassState) => {
  state.cursor = PASS_START;
  state.lastSeen = null;
  state.foreign = false;
  state.verifiedAt = null;
};

/**
 * Attaches the index file for the duration of `fn`. The index never keeps a rollback journal on
 * disk (`journal_mode = MEMORY`) and zeroes what it deletes (`secure_delete`): a journal slot
 * would keep old pages, that is old message text, after it is "deleted". The price is that a
 * crash mid-write can damage the file, which is what the `dirty` mark and `resetIndex` are for.
 */
function attempt<T>(db: SqlDb, state: PassState, prepare: boolean, fn: () => T): T {
  const keep = state.target.file === ':memory:';
  if (!state.attached) {
    db.run('ATTACH DATABASE ? AS search', [state.target.file]);
    state.attached = true;
    state.target.exists = true;
  }
  try {
    db.exec('PRAGMA search.journal_mode = MEMORY');
    db.exec('PRAGMA search.secure_delete = ON');
    if (prepare) prepareIndex(db, state);
    return fn();
  } finally {
    // Detached after use on disk, so the library's own transactions never span two files
    // (a second journal and a super-journal on every import). Memory has nothing to reopen.
    if (!keep) {
      try {
        db.exec('DETACH DATABASE search');
        state.attached = false;
      } catch {
        // still attached; the next call reuses it
      }
    }
  }
}

/** Throws the file away and forgets the pass: the next use starts from an empty index. */
function resetIndex(db: SqlDb, state: PassState): void {
  try {
    db.exec('DETACH DATABASE search');
  } catch {
    // not attached
  }
  state.attached = false;
  try {
    state.target.remove?.();
  } catch {
    // the next attempt tells whether it still fails
  }
  forgetPass(state);
  state.resetNeeded = false;
}

/**
 * Runs `fn` against the index. Any failure that is not ours (not a database, a damaged FTS5
 * table, an attach that fails) resets the index once and tries again; if that fails too the
 * search is `unavailable`. The index is a cache, so a reset only costs a rebuild.
 */
function withIndex<T>(db: SqlDb, fn: () => T): T {
  const state = stateOf(db);
  if (state.resetNeeded) resetIndex(db, state);
  try {
    return attempt(db, state, true, fn);
  } catch (error) {
    if (error instanceof DbError) throw error;
  }
  resetIndex(db, state);
  try {
    return attempt(db, state, true, fn);
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw unavailable('the search index is not available');
  }
}

function prepareIndex(db: SqlDb, state: PassState): void {
  db.exec(`CREATE TABLE IF NOT EXISTS search.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  const keys = new Map(db.all<{ key: string; value: string }>('SELECT key, value FROM search.meta').map((r) => [r.key, r.value]));
  // `dirty` outside a pass of this process: a write was cut short (tab closed, crash).
  const cutShort = keys.has('dirty') && state.cursor === PASS_START;
  if (keys.get('version') === String(SEARCH_INDEX_VERSION) && !cutShort) return;
  forgetPass(state);
  db.exec('BEGIN');
  try {
    db.exec(`
      DROP TABLE IF EXISTS search.docs;
      DELETE FROM search.meta;
      CREATE VIRTUAL TABLE search.docs USING fts5(text, fp UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
      INSERT INTO search.meta (key, value) VALUES ('version', '${SEARCH_INDEX_VERSION}');
    `);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw error;
  }
}

/**
 * Removes every trace of message text from the index file: the table is dropped and the file
 * vacuumed, so the status goes back to `not-built` and the next search rebuilds (about 3 s for
 * 200k messages). Called whenever messages are removed (undo of an import) or replaced (restore)
 * BEFORE the library changes, so deleted text never waits for a later reconcile. Costs nothing
 * when no index file exists. Never throws: if the file cannot be cleaned it is deleted on next use.
 */
export function discardSearchIndex(db: SqlDb): void {
  const state = states.get(db);
  if (!state?.target.exists) return;
  forgetPass(state);
  try {
    attempt(db, state, false, () => {
      db.exec('DROP TABLE IF EXISTS search.docs; DROP TABLE IF EXISTS search.meta');
      db.exec('VACUUM search');
    });
  } catch {
    state.resetNeeded = true;
  }
}

/**
 * Size of the index file in bytes, 0 when there is none. Read-only: it never creates, repairs or
 * resets the index (a file that cannot be read counts as 0).
 */
export function getSearchIndexBytes(db: SqlDb): number {
  const state = states.get(db);
  if (!state || (!state.attached && !state.target.exists)) return 0;
  try {
    return attempt(db, state, false, () => db.all<{ n: number }>("SELECT page_count * page_size AS n FROM pragma_page_count('search'), pragma_page_size('search')")[0].n);
  } catch {
    return 0;
  }
}

const isBuilt = (db: SqlDb) => db.all("SELECT 1 FROM search.meta WHERE key = 'built'").length > 0;

/** `not-built` until one full pass completed; `ready` while nothing changed since a clean pass. */
export function getSearchStatus(db: SqlDb): SearchStatus {
  return withIndex(db, () => {
    const total = db.all<{ n: number }>('SELECT count(*) AS n FROM messages')[0].n;
    if (!isBuilt(db)) return { state: 'not-built', total };
    const verified = stateOf(db).verifiedAt;
    return { state: verified !== null && verified === totalChanges(db) ? 'ready' : 'stale', total };
  });
}

/** What a message is searched by: its text and its media file name. */
const INDEXED_TEXT = `m.body || CASE WHEN m.media_name <> '' THEN ' ' || m.media_name ELSE '' END`;
const searchableText = (m: { body: string; mediaName: string }) => (m.mediaName === '' ? m.body : `${m.body} ${m.mediaName}`);

/**
 * One chunk of a reconcile pass: handles the next `limit` message ids after the cursor (removes
 * index rows that are gone or differ, adds the missing ones). The last chunk of a pass also drops
 * index rows past the last message. Calling it again after `finished` starts a new pass.
 */
export function stepSearchIndex(db: SqlDb, limit: number = SEARCH_DEFAULT_STEP): SearchIndexStep {
  if (!Number.isFinite(limit)) throw new DbError('invalid', 'limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), MIN_STEP), MAX_STEP);
  return withIndex(db, () => {
    const state = stateOf(db);
    const now = totalChanges(db);
    if (state.cursor === PASS_START) {
      state.foreign = false;
      // Committed before any chunk, cleared by the chunk that ends the pass: if it is still there
      // in a new session, a write was cut short and the index cannot be trusted.
      db.run("INSERT OR REPLACE INTO search.meta (key, value) VALUES ('dirty', '1')");
    } else if (state.lastSeen !== now) state.foreign = true;

    const [{ hi }] = db.all<{ hi: number | null }>(
      'SELECT max(id) AS hi FROM (SELECT id FROM main.messages WHERE id > ? ORDER BY id LIMIT ?)',
      [state.cursor, n],
    );
    let processed = 0;
    db.exec('BEGIN');
    try {
      if (hi === null) {
        db.run('DELETE FROM search.docs WHERE rowid > ?', [state.cursor]);
      } else {
        processed = db.all<{ n: number }>('SELECT count(*) AS n FROM main.messages WHERE id > ? AND id <= ?', [state.cursor, hi])[0].n;
        db.run(
          `DELETE FROM search.docs WHERE rowid > ? AND rowid <= ? AND NOT EXISTS (
             SELECT 1 FROM main.messages m WHERE m.id = search.docs.rowid AND substr(m.fingerprint, 1, 16) = search.docs.fp)`,
          [state.cursor, hi],
        );
        db.run(
          `INSERT INTO search.docs (rowid, text, fp)
           SELECT m.id, ${INDEXED_TEXT}, substr(m.fingerprint, 1, 16) FROM main.messages m
            WHERE m.id > ? AND m.id <= ? AND NOT EXISTS (SELECT 1 FROM search.docs d WHERE d.rowid = m.id)`,
          [state.cursor, hi],
        );
      }
      const finished = hi === null;
      if (finished) {
        db.run("INSERT OR REPLACE INTO search.meta (key, value) VALUES ('built', '1')");
        db.run("DELETE FROM search.meta WHERE key = 'dirty'");
      }
      db.exec('COMMIT');
      state.cursor = finished ? PASS_START : hi;
      state.lastSeen = totalChanges(db);
      const verified = finished && !state.foreign;
      if (finished) state.verifiedAt = verified ? state.lastSeen : null;
      return { processed, finished, verified };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      state.cursor = PASS_START;
      throw error;
    }
  });
}

export interface SearchInput {
  /** One person's conversations, one conversation, or (none) the whole archive. */
  scope?: { profileId?: string; conversationId?: string };
  query: string;
  offset: number;
  limit: number;
}

/**
 * Messages matching `query` (all words, the last one as a prefix from 2 letters; case and accents ignored), newest
 * first, `limit` from position `offset` (clamped to 1..MAX_WINDOW). An empty query finds nothing.
 * Needs a built index (`unavailable` otherwise: build it with `stepSearchIndex` first); results
 * are always checked against the archive, so a stale index misses new messages but never lies.
 */
export function searchMessages(db: SqlDb, input: SearchInput): SearchResult[] {
  if (typeof input !== 'object' || input === null) throw new DbError('invalid', 'params must be an object');
  const scope = input.scope ?? {};
  if (scope.profileId !== undefined && scope.conversationId !== undefined) {
    throw new DbError('invalid', 'scope takes a profile or a conversation, not both');
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new DbError('invalid', 'offset must be a non-negative integer');
  if (!Number.isFinite(input.limit)) throw new DbError('invalid', 'limit must be a number');
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_WINDOW);
  const params: SqlValue[] = [];
  let where = '';
  if (scope.profileId !== undefined) {
    where = 'AND m.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)';
    params.push(requireProfile(db, scope.profileId));
  } else if (scope.conversationId !== undefined) {
    where = 'AND m.conversation_id = ?';
    params.push(requireConversation(db, scope.conversationId));
  }
  const match = toMatchExpression(input.query);
  if (match === null) return [];

  return withIndex(db, () => {
    if (!isBuilt(db)) throw unavailable('the search index is not ready');
    const ids = db
      .all<{ id: number }>(
        `SELECT m.id FROM search.docs d JOIN main.messages m ON m.id = d.rowid AND substr(m.fingerprint, 1, 16) = d.fp
          WHERE docs MATCH ? ${where}
          ORDER BY m.sent_at DESC, m.ordinal DESC, m.conversation_id DESC, m.id DESC LIMIT ? OFFSET ?`,
        [match, ...params, limit, input.offset],
      )
      .map((r) => r.id);
    if (ids.length === 0) return [];
    const list = ids.map(() => '?').join(', ');
    const rows = new Map(
      db
        .all<WindowRow<SearchResult>>(
          `SELECT m.id, m.conversation_id AS conversationId, c.title AS conversationTitle, m.sent_at AS sentAt,
                  m.ordinal, m.type, p.display_name AS participantName, COALESCE(p.is_me, 0) AS isMe, m.body,
                  m.media_sha256 AS mediaSha256, m.media_name AS mediaName, b.mime AS mediaMime,
                  f.fingerprint IS NOT NULL AS isFavorite, nt.fingerprint IS NOT NULL AS hasNote
             FROM main.messages m
             JOIN main.conversations c ON c.id = m.conversation_id
             LEFT JOIN main.participants p ON p.id = m.participant_id
             LEFT JOIN main.blobs b ON b.sha256 = m.media_sha256
             LEFT JOIN main.favorites f ON f.conversation_id = m.conversation_id AND f.fingerprint = m.fingerprint
             LEFT JOIN main.notes nt ON nt.conversation_id = m.conversation_id AND nt.fingerprint = m.fingerprint
            WHERE m.id IN (${list})`,
          ids,
        )
        .map((r) => [r.id, toWindowMessage(r)] as const),
    );
    const out: SearchResult[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row) out.push({ ...row, snippet: snippetOf(searchableText(row), input.query) });
    }
    return out;
  });
}
