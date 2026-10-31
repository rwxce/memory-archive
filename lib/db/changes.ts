import type {
  BatchMessagesPage,
  ChangeSet,
  PackBatchHeader,
  PackBlob,
  PackConversation,
  PackFavorite,
  PackNote,
  PackNoteTarget,
  PackParticipant,
  PackProfile,
  PackTombstone,
  ReadBatchMessagesInput,
  ReadChangeSetInput,
} from '../domain/changes-pack';
import { DbError } from './errors';
import { readUserVersion } from './migrations';
import type { SqlDb, SqlValue } from './sql';
import { currentChangeSeq, getDeviceId, getPeer } from './sync';

/**
 * What a changes pack is built from (`docs/formats/changes-pack.md`, "What a pack contains"). Read
 * only: nothing here moves a watermark (that is `recordSent`, after the person has the file).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string) => new DbError('invalid', message);

/** Largest page of messages one call returns. */
export const MAX_BATCH_PAGE = 5000;

/** Conversations the pack touches: changed ones, plus those a changed batch, favorite or note belongs to. */
const CONVERSATIONS = `(SELECT id FROM conversations WHERE seq > ?
  UNION SELECT conversation_id FROM import_batches WHERE seq > ?
  UNION SELECT conversation_id FROM favorites WHERE seq > ?
  UNION SELECT conversation_id FROM notes WHERE seq > ? AND conversation_id IS NOT NULL)`;
const CONVERSATIONS_PARAMS = 4;

/** Profiles the pack touches: changed ones, plus those a carried conversation or note refers to. */
const PROFILES = `(SELECT id FROM profiles WHERE seq > ?
  UNION SELECT profile_id FROM conversation_profiles WHERE conversation_id IN ${CONVERSATIONS}
  UNION SELECT profile_id FROM participants WHERE profile_id IS NOT NULL AND conversation_id IN ${CONVERSATIONS}
  UNION SELECT profile_id FROM notes WHERE seq > ? AND profile_id IS NOT NULL)`;
const PROFILES_PARAMS = 2 + 2 * CONVERSATIONS_PARAMS;

const times = (since: number, n: number): SqlValue[] => Array.from({ length: n }, () => since);

/**
 * Reads the change counter and every record the pack needs in ONE synchronous step (the database
 * worker answers one request at a time, so nothing can write in between): `upTo` is exactly the
 * counter those records were cut at. `peerId` null, or `full`, gives every record for any device.
 * Messages are not included: they are paged by `readBatchMessages`.
 */
export function readChangeSet(db: SqlDb, input: ReadChangeSetInput): ChangeSet {
  const peerId = input.peerId;
  if (peerId !== null && (typeof peerId !== 'string' || !UUID.test(peerId))) throw invalid('peer id must be a lowercase UUID');
  if (input.full !== undefined && typeof input.full !== 'boolean') throw invalid('full must be a boolean');
  const sourceDeviceId = getDeviceId(db);
  if (peerId === sourceDeviceId) throw invalid('a device cannot send a pack to itself');
  const peer = peerId === null ? null : getPeer(db, peerId);
  const kind = peerId === null || input.full === true ? 'full' : 'changes';
  const since = kind === 'full' ? 0 : (peer?.lastSentSeq ?? 0);
  // A full pack has no target, so it cannot say what "the target" has merged: another device could take it.
  const ack = kind === 'changes' && peer !== null && peer.lastReceivedAt !== null ? peer.lastReceivedSeq : null;
  const upTo = currentChangeSeq(db);

  const conv = (): SqlValue[] => times(since, CONVERSATIONS_PARAMS);
  const profileRows = db.all<{
    id: string; displayName: string; relationship: string; description: string; photoSha256: string | null;
    archivedAt: string | null; createdAt: string; updatedAt: string; seq: number;
  }>(
    `SELECT id, display_name AS displayName, relationship, description, photo_sha256 AS photoSha256,
            archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt, seq
       FROM profiles WHERE id IN ${PROFILES} ORDER BY id`,
    times(since, PROFILES_PARAMS),
  );
  const profiles: PackProfile[] = profileRows.map((p) => ({
    id: p.id, displayName: p.displayName, relationship: p.relationship, description: p.description, photoSha256: p.photoSha256,
    archivedAt: p.archivedAt, createdAt: p.createdAt, updatedAt: p.updatedAt, seq: p.seq,
  }));

  const links = new Map<string, string[]>();
  for (const r of db.all<{ conversationId: string; profileId: string }>(
    `SELECT conversation_id AS conversationId, profile_id AS profileId FROM conversation_profiles
      WHERE conversation_id IN ${CONVERSATIONS} ORDER BY conversation_id, profile_id`,
    conv(),
  )) {
    (links.get(r.conversationId) ?? links.set(r.conversationId, []).get(r.conversationId)!).push(r.profileId);
  }
  const people = new Map<string, PackParticipant[]>();
  for (const r of db.all<{ conversationId: string; displayName: string; profileId: string | null; isMe: number }>(
    `SELECT conversation_id AS conversationId, display_name AS displayName, profile_id AS profileId, is_me AS isMe
       FROM participants WHERE conversation_id IN ${CONVERSATIONS} AND (profile_id IS NOT NULL OR is_me = 1)
      ORDER BY conversation_id, display_name`,
    conv(),
  )) {
    (people.get(r.conversationId) ?? people.set(r.conversationId, []).get(r.conversationId)!).push({
      displayName: r.displayName, profileId: r.profileId, isMe: r.isMe === 1,
    });
  }
  const conversations: PackConversation[] = db
    .all<{ id: string; title: string; source: string; sourceKey: string; isGroup: number; createdAt: string; seq: number }>(
      `SELECT id, title, source, source_key AS sourceKey, is_group AS isGroup, created_at AS createdAt, seq
         FROM conversations WHERE id IN ${CONVERSATIONS} ORDER BY id`,
      conv(),
    )
    .map((c) => ({
      id: c.id, title: c.title, source: c.source, sourceKey: c.sourceKey, isGroup: c.isGroup === 1, createdAt: c.createdAt, seq: c.seq,
      profileIds: links.get(c.id) ?? [],
      participants: people.get(c.id) ?? [],
    }));

  const batches: PackBatchHeader[] = db
    .all<{ id: string; conversationId: string; source: string; sourceLabel: string; createdAt: string; createdConversation: number; seq: number }>(
      `SELECT id, conversation_id AS conversationId, source, source_label AS sourceLabel, created_at AS createdAt,
              created_conversation AS createdConversation, seq
         FROM import_batches WHERE seq > ? ORDER BY id`,
      [since],
    )
    .map((b) => ({
      id: b.id, conversationId: b.conversationId, source: b.source, sourceLabel: b.sourceLabel, createdAt: b.createdAt,
      createdConversation: b.createdConversation === 1, seq: b.seq,
    }));

  // Media bytes only for what the carried messages and profile photos reference.
  const blobs = db.all<PackBlob>(
    `SELECT sha256, size, mime FROM blobs WHERE sha256 IN (
       SELECT photo_sha256 FROM profiles WHERE photo_sha256 IS NOT NULL AND id IN ${PROFILES}
       UNION SELECT media_sha256 FROM messages WHERE media_sha256 IS NOT NULL AND batch_id IN (SELECT id FROM import_batches WHERE seq > ?)
     ) ORDER BY sha256`,
    [...times(since, PROFILES_PARAMS), since],
  ).map((b) => ({ sha256: b.sha256, size: b.size, mime: b.mime }));

  const favorites: PackFavorite[] = db
    .all<PackFavorite>(
      `SELECT conversation_id AS conversationId, fingerprint, created_at AS createdAt, seq
         FROM favorites WHERE seq > ? ORDER BY conversation_id, fingerprint`,
      [since],
    )
    .map((f) => ({ conversationId: f.conversationId, fingerprint: f.fingerprint, createdAt: f.createdAt, seq: f.seq }));

  const notes: PackNote[] = db
    .all<{ kind: string; profileId: string | null; conversationId: string | null; fingerprint: string | null; body: string; createdAt: string; updatedAt: string; seq: number }>(
      `SELECT kind, profile_id AS profileId, conversation_id AS conversationId, fingerprint, body,
              created_at AS createdAt, updated_at AS updatedAt, seq
         FROM notes WHERE seq > ? ORDER BY kind, coalesce(profile_id, ''), coalesce(conversation_id, ''), coalesce(fingerprint, '')`,
      [since],
    )
    .map((n) => ({
      target: noteTarget(n),
      body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt, seq: n.seq,
    }));

  const tombstones: PackTombstone[] = db
    .all<PackTombstone>(
      'SELECT kind, scope, key, deleted_at AS deletedAt, seq FROM tombstones WHERE seq > ? ORDER BY kind, scope, key',
      [since],
    )
    .map((t) => ({ kind: t.kind, scope: t.scope, key: t.key, deletedAt: t.deletedAt, seq: t.seq }));

  return {
    schemaVersion: readUserVersion(db),
    kind,
    sourceDeviceId,
    targetDeviceId: kind === 'changes' ? peerId : null,
    since,
    upTo,
    ack,
    profiles, conversations, blobs, favorites, notes, tombstones, batches,
  };
}

function noteTarget(n: { kind: string; profileId: string | null; conversationId: string | null; fingerprint: string | null }): PackNoteTarget {
  if (n.kind === 'profile' && n.profileId !== null) return { kind: 'profile', profileId: n.profileId };
  if (n.kind === 'conversation' && n.conversationId !== null) return { kind: 'conversation', conversationId: n.conversationId };
  if (n.kind === 'message' && n.conversationId !== null && n.fingerprint !== null) {
    return { kind: 'message', conversationId: n.conversationId, fingerprint: n.fingerprint };
  }
  throw new DbError('internal', 'a note row has an impossible target');
}

/**
 * One page of an import batch's messages in insertion order, after the local row id `after`.
 * Messages never change, so paging is consistent as long as the batch is not undone meanwhile
 * (the use case holds the archive guard, which keeps undo out).
 */
export function readBatchMessages(db: SqlDb, input: ReadBatchMessagesInput): BatchMessagesPage {
  if (typeof input.batchId !== 'string' || !UUID.test(input.batchId)) throw invalid('batch id must be a lowercase UUID');
  if (!Number.isSafeInteger(input.after) || input.after < 0) throw invalid('after must be a non-negative integer');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_BATCH_PAGE) throw invalid('limit is out of range');
  const rows = db.all<{
    id: number; fingerprint: string; sentAt: string; ordinal: number; type: string; author: string | null;
    body: string; mediaSha256: string | null; mediaName: string;
  }>(
    `SELECT m.id, m.fingerprint, m.sent_at AS sentAt, m.ordinal, m.type, p.display_name AS author, m.body,
            m.media_sha256 AS mediaSha256, m.media_name AS mediaName
       FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
      WHERE m.batch_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`,
    [input.batchId, input.after, input.limit],
  );
  return {
    messages: rows.map((r) => ({
      fingerprint: r.fingerprint, sentAt: r.sentAt, ordinal: r.ordinal, type: r.type, author: r.author, body: r.body,
      mediaSha256: r.mediaSha256, mediaName: r.mediaName,
    })),
    last: rows.length > 0 ? rows[rows.length - 1].id : input.after,
  };
}
