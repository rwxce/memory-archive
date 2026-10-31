import type { PackConversation, PackNote, PackProfile, PackTombstone } from '../domain/changes-pack';
import {
  PackRecordError,
  parsePackConversation,
  parsePackNote,
  parsePackProfile,
  parsePackTombstone,
} from '../domain/changes-pack-parse';
import { normalizeNote, FieldError } from '../domain/profile';
import type { ConflictChoice, ConflictKind, ResolveConflictInput, SyncConflict } from '../domain/sync';
import { DbError } from './errors';
import {
  insertNote,
  noteWhere,
  readLocalConversation,
  readLocalNote,
  readLocalProfile,
  writeConversation,
  writeProfile,
  heldByConflicts,
} from './merge';
import { isReferenced } from './queries';
import { transaction, type SqlDb } from './sql';
import { clearTombstone, recordTombstone, stampRows } from './sync';

/**
 * The conflicts a changes-pack merge left open (`docs/formats/changes-pack.md`, "Conflicts"), and
 * their resolution. The active record was never touched by the merge; resolving is an ordinary
 * LOCAL edit: it takes a new `seq` with `changed_by` NULL, travels as a normal change, and on the
 * other device it fast-forwards. Nothing is picked silently and nothing is dropped.
 */

const invalid = (message: string) => new DbError('invalid', message);

interface Row {
  id: number;
  peerId: string;
  kind: ConflictKind;
  scope: string;
  key: string;
  incoming: string;
  incomingDeleted: number;
  detectedAt: string;
}

const SELECT = `SELECT id, peer_id AS peerId, kind, scope, key, incoming, incoming_deleted AS incomingDeleted, detected_at AS detectedAt
                  FROM sync_conflicts`;

function parseIncoming(row: Row): PackProfile | PackConversation | PackNote | PackTombstone {
  try {
    const raw: unknown = JSON.parse(row.incoming);
    if (row.incomingDeleted === 1) return parsePackTombstone(raw);
    if (row.kind === 'profile') return parsePackProfile(raw);
    if (row.kind === 'conversation') return parsePackConversation(raw);
    return parsePackNote(raw);
  } catch (error) {
    if (error instanceof PackRecordError || error instanceof SyntaxError) throw new DbError('internal', 'a stored conflict is damaged');
    throw error;
  }
}

function noteTargetOf(scope: string, key: string): PackNote['target'] {
  if (scope === '') return { kind: 'profile', profileId: key.slice('profile:'.length) };
  if (key === 'conversation') return { kind: 'conversation', conversationId: scope };
  return { kind: 'message', conversationId: scope, fingerprint: key.slice('message:'.length) };
}

function toConflict(db: SqlDb, row: Row): SyncConflict {
  let local: SyncConflict['local'] = null;
  let matched: boolean | undefined;
  if (row.kind === 'profile') {
    const l = readLocalProfile(db, row.key);
    local = l && stripLocal(l);
  } else if (row.kind === 'conversation') {
    const l = readLocalConversation(db, row.key);
    local = l && stripLocal(l);
  } else if (row.kind === 'note') {
    const l = readLocalNote(db, noteTargetOf(row.scope, row.key));
    local = l && stripLocal(l);
  } else {
    matched = db.all('SELECT 1 FROM import_batches WHERE id = ?', [row.key]).length > 0;
  }
  return {
    id: row.id, peerId: row.peerId, kind: row.kind, scope: row.scope, key: row.key,
    incoming: parseIncoming(row), incomingDeleted: row.incomingDeleted === 1, detectedAt: row.detectedAt, local,
    ...(matched === undefined ? {} : { matched }),
  };
}

function stripLocal<T extends { seq: number; changedBy: string | null }>(l: T): Omit<T, 'seq' | 'changedBy'> {
  const { seq: _seq, changedBy: _changedBy, ...rest } = l;
  return rest;
}

/** Every open conflict and offered batch undo, oldest first. */
export function listConflicts(db: SqlDb): SyncConflict[] {
  return db.all<Row>(`${SELECT} ORDER BY id`).map((row) => toConflict(db, row));
}

export function countConflicts(db: SqlDb): number {
  return db.all<{ n: number }>('SELECT count(*) AS n FROM sync_conflicts')[0].n;
}

export interface ResolveConflictResult {
  /** Media rows this resolution left unreferenced (a replaced or refused profile photo): rows gone, the caller deletes the bytes. */
  unreferencedBlobs: string[];
  /**
   * The record the conflict was about no longer exists here and could not be brought back (`theirs`):
   * the conflict is closed and nothing was applied. `mine` on a missing record just closes it.
   */
  recordGone: boolean;
}

/**
 * Settles one conflict.
 * - profile / conversation: `mine` keeps the active record and re-stamps it so it travels (the other
 *   device fast-forwards); `theirs` takes the peer's version. If the local record is gone meanwhile,
 *   `mine` closes the conflict and `theirs` recreates the record when it can (`recordGone` when not).
 * - note: `mine`, `theirs`, or `both` (the peer's text appended below ours, refused when the result
 *   would be longer than a note may be).
 * - batch (an undone import offered for removal): only `mine` (dismiss) is handled here; accepting
 *   runs the ordinary undo (a use case, because media bytes must be deleted too) and then dismisses.
 * `not-found` when the conflict is gone (resolved meanwhile); `invalid` for a choice that does not fit.
 */
export function resolveConflict(db: SqlDb, input: ResolveConflictInput): ResolveConflictResult {
  if (typeof input !== 'object' || input === null) throw invalid('params must be an object');
  if (!Number.isSafeInteger(input.id)) throw invalid('id must be an integer');
  if (input.choice !== 'mine' && input.choice !== 'theirs' && input.choice !== 'both') throw invalid('choice must be mine, theirs or both');
  if (typeof input.now !== 'string' || input.now === '') throw invalid('now must be a string');
  return transaction(db, () => {
    const row = db.all<Row>(`${SELECT} WHERE id = ?`, [input.id])[0];
    if (!row) throw new DbError('not-found', 'conflict not found');
    // Media rows this resolution may leave unreferenced; freed below unless something still needs them.
    const candidates = new Set<string>();
    let recordGone = false;
    const choice: ConflictChoice = input.choice;
    if (row.kind === 'batch') {
      if (choice !== 'mine') throw invalid('an undone import is accepted by undoing it, or dismissed with mine');
    } else if (row.kind === 'note') {
      resolveNote(db, row, choice, input.now);
    } else {
      if (choice === 'both') throw invalid('both applies to notes only');
      const incoming = parseIncoming(row);
      if (row.kind === 'profile') {
        const profile = incoming as PackProfile;
        const before = readLocalProfile(db, profile.id);
        // The incoming photo was stored for the choice; it only stays if the profile takes it.
        if (profile.photoSha256 !== null) candidates.add(profile.photoSha256);
        if (!before) {
          if (choice === 'theirs') recordGone = !recreate(() => writeProfile(db, profile, true));
          if (choice === 'theirs' && !recordGone) stampRows(db, 'profiles', 'id = ?', [profile.id]);
        } else {
          if (choice === 'theirs') {
            writeProfile(db, profile, false);
            if (before.photoSha256 !== null && before.photoSha256 !== profile.photoSha256) candidates.add(before.photoSha256);
          }
          stampRows(db, 'profiles', 'id = ?', [profile.id]);
        }
      } else {
        const conversation = incoming as PackConversation;
        if (!readLocalConversation(db, conversation.id)) {
          if (choice === 'theirs') recordGone = !recreate(() => writeConversation(db, conversation, true));
          if (choice === 'theirs' && !recordGone) stampRows(db, 'conversations', 'id = ?', [conversation.id]);
        } else {
          if (choice === 'theirs') writeConversation(db, conversation, false);
          stampRows(db, 'conversations', 'id = ?', [conversation.id]);
        }
      }
    }
    db.run('DELETE FROM sync_conflicts WHERE id = ?', [row.id]);
    const held = heldByConflicts(db);
    const unreferencedBlobs: string[] = [];
    for (const sha256 of candidates) {
      if (held.has(sha256) || isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return { unreferencedBlobs, recordGone };
  });
}

/** Runs a write that checks its references first; `false` when one is missing (nothing was written). */
function recreate(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    if (error instanceof DbError && error.code === 'invalid') return false;
    throw error;
  }
}

function resolveNote(db: SqlDb, row: Row, choice: ConflictChoice, now: string): void {
  const target = noteTargetOf(row.scope, row.key);
  const w = noteWhere(target);
  const local = readLocalNote(db, target);
  if (row.incomingDeleted === 1) {
    // Deleted there, edited here (or already gone here: nothing to decide).
    if (!local) return;
    if (choice === 'theirs') {
      db.run(`DELETE FROM notes WHERE ${w.where}`, w.params);
      recordTombstone(db, 'note', row.scope, row.key, now);
    } else stampRows(db, 'notes', w.where, w.params);
    return;
  }
  const incoming = parsePackNote(JSON.parse(row.incoming));
  if (!local) {
    // Deleted here, edited there: `mine` keeps it deleted (and tells the peer again), anything else brings the note back.
    if (choice === 'mine') recordTombstone(db, 'note', row.scope, row.key, now);
    else {
      insertNote(db, target, incoming.body, incoming.createdAt, now);
      clearTombstone(db, 'note', row.scope, row.key);
      stampRows(db, 'notes', w.where, w.params);
    }
    return;
  }
  if (choice === 'mine') {
    stampRows(db, 'notes', w.where, w.params);
    return;
  }
  let body = incoming.body;
  if (choice === 'both') {
    try {
      body = normalizeNote(`${local.body}\n\n${incoming.body}`);
    } catch (error) {
      if (error instanceof FieldError) throw invalid('the two notes together are longer than a note may be');
      throw error;
    }
  }
  db.run(`UPDATE notes SET body = ?, updated_at = ? WHERE ${w.where}`, [body, now, ...w.params]);
  stampRows(db, 'notes', w.where, w.params);
}
