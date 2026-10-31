import type { RecordReceivedInput, RecordSentInput, RecordSentResult, SyncPeer, UnsentChanges } from '../domain/sync';
import { DbError } from './errors';
import type { SqlDb } from './sql';

/**
 * Change tracking and device identity for manual device-to-device sync (schema v8; format in
 * `docs/formats/changes-pack.md`). Nothing here talks to another device: it only records what
 * changed here and what this device has exchanged with each peer.
 *
 * - `device` holds this library's identity and a monotonic change counter. The migration creates the
 *   row; a restore replaces the id (`renewDevice`), so a backup never clones another device's id.
 * - Every write to a synced record stamps it with `nextChangeSeq` (`seq`); a changes pack for a
 *   peer is "records with `seq` above the watermark last sent to that peer".
 * - Deleting a favorite, a note or an import batch leaves a `tombstones` row so the deletion can
 *   travel. Recreating the target removes the tombstone.
 * - `sync_peers` keeps, per peer, the watermarks exchanged with it.
 *
 * No triggers (a snapshot with triggers is refused): the write paths in `queries.ts` call these.
 */

/** Baseline `seq` of rows that existed when schema v8 was applied, and the counter's first value. */
export const BASELINE_SEQ = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string) => new DbError('invalid', message);

/** SQL expression for a fresh random v4-shaped UUID (lowercase, 36 characters). */
export const RANDOM_UUID_SQL = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;

/** SQL expression for the current UTC instant, millisecond precision (ISO 8601). */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${field} must be a lowercase UUID`);
  return value;
}

function requireSeq(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a non-negative integer`);
  return value;
}

/** Safety net: creates the device row when it is missing (the migration normally has). */
export function ensureDevice(db: SqlDb): void {
  db.run(`INSERT OR IGNORE INTO device (singleton, id, created_at, change_seq) VALUES (1, ${RANDOM_UUID_SQL}, ${NOW_SQL}, ${BASELINE_SEQ})`);
}

/** This library's device id (created on first call). Stable until the library is restored or replaced. */
export function getDeviceId(db: SqlDb): string {
  ensureDevice(db);
  return db.all<{ id: string }>('SELECT id FROM device WHERE singleton = 1')[0].id;
}

/** This library's device id WITHOUT creating the row: `null` when there is none yet. For read-only callers (reminders). */
export function peekDeviceId(db: SqlDb): string | null {
  return db.all<{ id: string }>('SELECT id FROM device WHERE singleton = 1')[0]?.id ?? null;
}

/** The counter's current value: the highest `seq` handed out so far (`BASELINE_SEQ` when nothing changed since v8). */
export function currentChangeSeq(db: SqlDb): number {
  ensureDevice(db);
  return db.all<{ n: number }>('SELECT change_seq AS n FROM device WHERE singleton = 1')[0].n;
}

/** Hands out the next change number. Call inside the transaction of the write it stamps. */
export function nextChangeSeq(db: SqlDb): number {
  ensureDevice(db);
  db.run('UPDATE device SET change_seq = change_seq + 1 WHERE singleton = 1');
  return currentChangeSeq(db);
}

/** Tables whose rows carry `seq` (and `changed_by` where listed in `CHANGED_BY`). */
export type StampedTable = 'profiles' | 'conversations' | 'import_batches' | 'favorites' | 'notes';
const CHANGED_BY: ReadonlySet<StampedTable> = new Set(['profiles', 'conversations', 'import_batches', 'notes', 'favorites']);

/**
 * Marks the rows matching `where` as changed here, now: new `seq`, and `changed_by` back to NULL
 * (this device) on tables that have it. `where` is a fixed fragment written by the caller.
 */
export function stampRows(db: SqlDb, table: StampedTable, where: string, params: readonly (string | number | null)[]): void {
  const seq = nextChangeSeq(db);
  const set = CHANGED_BY.has(table) ? 'seq = ?, changed_by = NULL' : 'seq = ?';
  db.run(`UPDATE ${table} SET ${set} WHERE ${where}`, [seq, ...params]);
}

/**
 * Like `stampRows`, for a version merged from `peerId`: it gets a new local `seq` (so it reaches a
 * third device through this one) but `changed_by` names the peer, so it never counts as a local
 * edit against that same peer (a false conflict).
 */
export function stampMergedRows(
  db: SqlDb,
  table: StampedTable,
  peerId: string,
  where: string,
  params: readonly (string | number | null)[],
): void {
  const seq = nextChangeSeq(db);
  db.run(`UPDATE ${table} SET seq = ?, changed_by = ? WHERE ${where}`, [seq, peerId, ...params]);
}

/** A deletion merged from `peerId`: kept (so it travels on) with a new local `seq` and the peer as `changed_by`. */
export function recordMergedTombstone(db: SqlDb, peerId: string, kind: TombstoneKind, scope: string, key: string, deletedAt: string): void {
  const seq = nextChangeSeq(db);
  db.run('INSERT OR REPLACE INTO tombstones (kind, scope, key, deleted_at, seq, changed_by) VALUES (?, ?, ?, ?, ?, ?)', [
    kind,
    scope,
    key,
    deletedAt,
    seq,
    peerId,
  ]);
}

export type TombstoneKind = 'favorite' | 'note' | 'batch';

/**
 * Records that a favorite, note or import batch was deleted here. `scope` is the conversation id
 * ('' for a person's note), `key` the fingerprint / note target / batch id (see the format doc).
 * `now` defaults to the current UTC instant. Replaces an older tombstone of the same target.
 */
export function recordTombstone(db: SqlDb, kind: TombstoneKind, scope: string, key: string, now?: string): void {
  const seq = nextChangeSeq(db);
  db.run(`INSERT OR REPLACE INTO tombstones (kind, scope, key, deleted_at, seq) VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}), ?)`, [
    kind,
    scope,
    key,
    now ?? null,
    seq,
  ]);
}

/** Forgets a tombstone because its target exists again. */
export function clearTombstone(db: SqlDb, kind: TombstoneKind, scope: string, key: string): void {
  db.run('DELETE FROM tombstones WHERE kind = ? AND scope = ? AND key = ?', [kind, scope, key]);
}

// ------------------------------------------------------------------- peers

const PEER_SELECT = `SELECT peer_id AS peerId, last_sent_seq AS lastSentSeq, last_sent_at AS lastSentAt,
       last_received_seq AS lastReceivedSeq, last_received_at AS lastReceivedAt FROM sync_peers`;

/** Every known peer, most recently active first (ties by id). */
export function listPeers(db: SqlDb): SyncPeer[] {
  return db.all<SyncPeer>(`${PEER_SELECT} ORDER BY max(coalesce(last_sent_at, ''), coalesce(last_received_at, '')) DESC, peer_id`);
}

/**
 * For every known peer, how many own records `readChangeSet(db, { peerId })` would carry: profiles,
 * conversations, favorites, notes, tombstones and import batches above its sent watermark that did
 * not come from that peer (same echo rule as `FRESH` in `changes.ts`). COUNT only. Rows a pack
 * pulls in only because a carried record references them (a profile or conversation of a batch)
 * are not counted; they are never the sole reason for a pack, so `count > 0` holds exactly when
 * the pack would carry any record. Messages and blobs are not counted. `lastSentAt` and
 * `lastExchangeAt` (the later of sent / received) let a caller judge whether the peer is still in play.
 */
export function countUnsentChanges(db: SqlDb): UnsentChanges[] {
  const fresh = (t: string) => `(SELECT count(*) FROM ${t} WHERE seq > p.last_sent_seq AND (changed_by IS NULL OR changed_by <> p.peer_id))`;
  return db.all<UnsentChanges>(
    `SELECT p.peer_id AS peerId,
            ${['profiles', 'conversations', 'import_batches', 'favorites', 'notes', 'tombstones'].map(fresh).join(' + ')} AS count,
            p.last_sent_at AS lastSentAt,
            CASE WHEN p.last_sent_at IS NULL THEN p.last_received_at
                 WHEN p.last_received_at IS NULL OR p.last_sent_at >= p.last_received_at THEN p.last_sent_at
                 ELSE p.last_received_at END AS lastExchangeAt
       FROM sync_peers p ORDER BY p.peer_id`,
  );
}

/** The state for one peer; `null` when this device never exchanged anything with it. */
export function getPeer(db: SqlDb, peerId: string): SyncPeer | null {
  requireUuid(peerId, 'peer id');
  return db.all<SyncPeer>(`${PEER_SELECT} WHERE peer_id = ?`, [peerId])[0] ?? null;
}

function ensurePeer(db: SqlDb, peerId: string): void {
  if (peerId === getDeviceId(db)) throw invalid('a device cannot be its own sync peer');
  db.run('INSERT OR IGNORE INTO sync_peers (peer_id) VALUES (?)', [peerId]);
}

/**
 * A changes pack for `peerId` was produced up to `upToSeq`. Without `sinceSeq` the watermark only
 * moves forward; with it (a pack of changes) it moves only from exactly `sinceSeq`. It is
 * optimistic until the peer's next pack confirms it (`recordReceived` with `ackedSeq`).
 */
export function recordSent(db: SqlDb, input: RecordSentInput): RecordSentResult {
  const peerId = requireUuid(input.peerId, 'peer id');
  const upToSeq = requireSeq(input.upToSeq, 'upToSeq');
  const since = input.sinceSeq === undefined || input.sinceSeq === null ? null : requireSeq(input.sinceSeq, 'sinceSeq');
  if (typeof input.now !== 'string' || input.now === '') throw invalid('now must be a string');
  if (upToSeq > currentChangeSeq(db)) throw invalid('upToSeq is beyond this device\'s change counter');
  if (since === null) {
    ensurePeer(db, peerId);
    db.run('UPDATE sync_peers SET last_sent_seq = max(last_sent_seq, ?), last_sent_at = ? WHERE peer_id = ?', [upToSeq, input.now, peerId]);
    return { recorded: true, peer: getPeer(db, peerId)! };
  }
  if (since > upToSeq) throw invalid('sinceSeq is above upToSeq');
  // Compare-and-set: the watermark moves only if nothing (an ack, a newer pack) changed it since the pack was cut.
  const known = getPeer(db, peerId);
  if (known === null && since !== 0) return { recorded: false, peer: { peerId, lastSentSeq: 0, lastSentAt: null, lastReceivedSeq: 0, lastReceivedAt: null } };
  ensurePeer(db, peerId);
  const changed = db.run('UPDATE sync_peers SET last_sent_seq = ?, last_sent_at = ? WHERE peer_id = ? AND last_sent_seq = ?', [
    upToSeq,
    input.now,
    peerId,
    since,
  ]);
  return { recorded: changed > 0, peer: getPeer(db, peerId)! };
}

/**
 * A pack from `peerId` was merged completely. Call it in the SAME transaction as the merge, so a
 * failed merge leaves the watermark where it was. The received watermark only moves forward.
 */
export function recordReceived(db: SqlDb, input: RecordReceivedInput): SyncPeer {
  const peerId = requireUuid(input.peerId, 'peer id');
  const upToSeq = requireSeq(input.upToSeq, 'upToSeq');
  const acked = input.ackedSeq === null ? null : requireSeq(input.ackedSeq, 'ackedSeq');
  if (typeof input.now !== 'string' || input.now === '') throw invalid('now must be a string');
  ensurePeer(db, peerId);
  db.run('UPDATE sync_peers SET last_received_seq = max(last_received_seq, ?), last_received_at = ? WHERE peer_id = ?', [
    upToSeq,
    input.now,
    peerId,
  ]);
  if (acked !== null) {
    db.run('UPDATE sync_peers SET last_sent_seq = min(?, ?) WHERE peer_id = ?', [acked, currentChangeSeq(db), peerId]);
  }
  return getPeer(db, peerId)!;
}

/**
 * Gives a restored or replaced library a NEW identity: a fresh device id, no peers, and a counter
 * that continues from the restored data (never below `BASELINE_SEQ`). A restore is a different
 * device incarnation: reusing the old id would let two libraries claim the same watermarks and
 * silently skip each other's changes. Runs inside the restore transaction.
 */
export function renewDevice(db: SqlDb, changeSeq: number): void {
  db.run('DELETE FROM sync_peers');
  db.run('DELETE FROM device');
  db.run(`INSERT INTO device (singleton, id, created_at, change_seq) VALUES (1, ${RANDOM_UUID_SQL}, ${NOW_SQL}, ?)`, [
    Math.max(BASELINE_SEQ, changeSeq),
  ]);
}

/**
 * Records the deletions a conversation's removal cascades into (its favorites, its conversation
 * and message notes, its other import batches), in the removing transaction and BEFORE the
 * conversation row goes. `exceptBatchId` is the batch whose own undo already left a tombstone.
 */
export function recordConversationCascade(db: SqlDb, conversationId: string, exceptBatchId: string): void {
  const seq = nextChangeSeq(db);
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  db.run(
    `INSERT OR REPLACE INTO tombstones (kind, scope, key, deleted_at, seq)
     SELECT 'favorite', conversation_id, fingerprint, ${now}, ? FROM favorites WHERE conversation_id = ?`,
    [seq, conversationId],
  );
  db.run(
    `INSERT OR REPLACE INTO tombstones (kind, scope, key, deleted_at, seq)
     SELECT 'note', conversation_id, CASE kind WHEN 'conversation' THEN 'conversation' ELSE 'message:' || fingerprint END, ${now}, ?
       FROM notes WHERE conversation_id = ?`,
    [seq, conversationId],
  );
  db.run(
    `INSERT OR REPLACE INTO tombstones (kind, scope, key, deleted_at, seq)
     SELECT 'batch', conversation_id, id, ${now}, ? FROM import_batches WHERE conversation_id = ? AND id <> ?`,
    [seq, conversationId, exceptBatchId],
  );
}
