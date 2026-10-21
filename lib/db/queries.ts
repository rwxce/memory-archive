import {
  isLocalTimestamp,
  isMessageType,
  isSha256Hex,
  isUuid,
  type BlobRef,
  type ConversationSummary,
  type MessageCursor,
  type NewMessage,
  type Participant,
  type Profile,
  type StoredMessage,
} from '../domain/library';
import { DbError } from './errors';
import { transaction, type SqlDb } from './sql';

/**
 * The only module that issues SQL for archive data. Every function takes the
 * database first, is synchronous, and runs identically against the in-memory
 * database (Node tests) and the OPFS one (Web Worker). All values are bound
 * parameters; the SQLite CHECK / UNIQUE / FOREIGN KEY rules in
 * `migrations.ts` are the last line of defence behind the early checks here.
 */

function invalid(message: string): never {
  throw new DbError('invalid', message);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) invalid(`${field} must be a lowercase UUID`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------- profiles

export interface CreateProfileInput {
  id: string;
  displayName: string;
  /** UTC instant (ISO 8601). */
  now: string;
}

export function createProfile(db: SqlDb, input: CreateProfileInput): Profile {
  requireRecord(input, 'params');
  requireUuid(input.id, 'profile id');
  requireString(input.displayName, 'displayName');
  requireString(input.now, 'now');
  db.run('INSERT INTO profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    input.id,
    input.displayName,
    input.now,
    input.now,
  ]);
  return { id: input.id, displayName: input.displayName, archivedAt: null, createdAt: input.now, updatedAt: input.now };
}

export function listProfiles(db: SqlDb): Profile[] {
  return db.all<Profile>(
    `SELECT id, display_name AS displayName, archived_at AS archivedAt,
            created_at AS createdAt, updated_at AS updatedAt
       FROM profiles ORDER BY created_at, id`,
  );
}

// ----------------------------------------------------------- conversations

export interface CreateConversationInput {
  id: string;
  title: string;
  source: string;
  isGroup: boolean;
  /** Profiles the conversation belongs to (may be empty: not assigned yet). */
  profileIds: string[];
  /** Participants known up front; more are added as messages are imported. */
  participants: Participant[];
  now: string;
}

export function createConversation(db: SqlDb, input: CreateConversationInput): void {
  requireRecord(input, 'params');
  requireUuid(input.id, 'conversation id');
  requireString(input.title, 'title');
  requireString(input.source, 'source');
  requireString(input.now, 'now');
  for (const profileId of requireArray(input.profileIds, 'profileIds')) requireUuid(profileId, 'profile id');
  for (const p of requireArray(input.participants, 'participants')) {
    requireString(requireRecord(p, 'participant').displayName, 'participant displayName');
  }
  transaction(db, () => {
    db.run('INSERT INTO conversations (id, title, source, is_group, created_at) VALUES (?, ?, ?, ?, ?)', [
      input.id,
      input.title,
      input.source,
      input.isGroup ? 1 : 0,
      input.now,
    ]);
    for (const profileId of new Set(input.profileIds)) {
      db.run('INSERT INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [input.id, profileId]);
    }
    for (const p of input.participants) {
      if (p.profileId !== null) requireUuid(p.profileId, 'participant profile id');
      db.run('INSERT INTO participants (conversation_id, display_name, profile_id) VALUES (?, ?, ?)', [
        input.id,
        p.displayName,
        p.profileId,
      ]);
    }
  });
}

interface ConversationRow {
  id: string;
  title: string;
  source: string;
  is_group: number;
  created_at: string;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
}

/** Conversations, optionally only those linked to `profileId`, oldest first. */
export function listConversations(db: SqlDb, filter: { profileId?: string } = {}): ConversationSummary[] {
  requireRecord(filter, 'params');
  if (filter.profileId !== undefined) requireUuid(filter.profileId, 'profile id');
  const rows = db.all<ConversationRow>(
    `SELECT c.id, c.title, c.source, c.is_group, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT MIN(m.sent_at) FROM messages m WHERE m.conversation_id = c.id) AS first_message_at,
            (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
       FROM conversations c
      ${filter.profileId === undefined ? '' : 'WHERE c.id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)'}
      ORDER BY c.created_at, c.id`,
    filter.profileId === undefined ? undefined : [filter.profileId],
  );
  const links = db.all<{ conversation_id: string; profile_id: string }>(
    'SELECT conversation_id, profile_id FROM conversation_profiles ORDER BY profile_id',
  );
  const byConversation = new Map<string, string[]>();
  for (const l of links) {
    const list = byConversation.get(l.conversation_id);
    if (list) list.push(l.profile_id);
    else byConversation.set(l.conversation_id, [l.profile_id]);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    isGroup: r.is_group === 1,
    createdAt: r.created_at,
    profileIds: byConversation.get(r.id) ?? [],
    messageCount: r.message_count,
    firstMessageAt: r.first_message_at,
    lastMessageAt: r.last_message_at,
  }));
}

export function listParticipants(db: SqlDb, conversationId: string): Participant[] {
  requireUuid(conversationId, 'conversation id');
  return db.all<Participant>(
    `SELECT display_name AS displayName, profile_id AS profileId
       FROM participants WHERE conversation_id = ? ORDER BY id`,
    [conversationId],
  );
}

// ---------------------------------------------------------------- messages

export interface ImportMessagesInput {
  batchId: string;
  conversationId: string;
  source: string;
  /** Free-text origin shown in history (e.g. the ZIP name). Untrusted. */
  sourceLabel: string;
  now: string;
  /** Media referenced by `messages`, already stored by hash. */
  blobs: BlobRef[];
  messages: NewMessage[];
}

export interface ImportMessagesResult {
  batchId: string;
  added: number;
  /** Messages already in the conversation (same fingerprint): not stored again. */
  skipped: number;
}

/**
 * Stores one import in a single transaction. Idempotent: a message whose
 * fingerprint is already in the conversation is skipped, so re-importing the
 * same export, or a newer export that overlaps it, adds only what is new. If
 * anything fails, nothing is stored (not even the batch row).
 */
export function importMessages(db: SqlDb, input: ImportMessagesInput): ImportMessagesResult {
  requireRecord(input, 'params');
  requireUuid(input.batchId, 'batch id');
  requireUuid(input.conversationId, 'conversation id');
  requireString(input.source, 'source');
  requireString(input.sourceLabel, 'sourceLabel');
  requireString(input.now, 'now');
  for (const b of requireArray(input.blobs, 'blobs') as BlobRef[]) {
    requireRecord(b, 'blob');
    if (!isSha256Hex(b.sha256)) invalid('blob sha256 must be 64 lowercase hex characters');
    if (!Number.isSafeInteger(b.size) || b.size < 0) invalid('blob size must be a non-negative integer');
  }
  for (const m of requireArray(input.messages, 'messages') as NewMessage[]) {
    requireRecord(m, 'message');
    requireString(m.body, 'message body');
    requireString(m.mediaName, 'message mediaName');
    if (m.participantName !== null) requireString(m.participantName, 'message participantName');
    if (!isSha256Hex(m.fingerprint)) invalid('message fingerprint must be 64 lowercase hex characters');
    if (!isLocalTimestamp(m.sentAt)) invalid('message sentAt must be YYYY-MM-DDTHH:MM:SS');
    if (!isMessageType(m.type)) invalid('unknown message type');
    if (!Number.isSafeInteger(m.ordinal) || m.ordinal < 0) invalid('message ordinal must be a non-negative integer');
    if (m.mediaSha256 !== null && !isSha256Hex(m.mediaSha256)) invalid('message media hash must be 64 lowercase hex');
  }

  return transaction(db, () => {
    db.run('INSERT INTO import_batches (id, conversation_id, source, source_label, created_at) VALUES (?, ?, ?, ?, ?)', [
      input.batchId,
      input.conversationId,
      input.source,
      input.sourceLabel,
      input.now,
    ]);
    for (const b of input.blobs) {
      db.run('INSERT OR IGNORE INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [b.sha256, b.size, b.mime]);
    }

    const participantIds = new Map<string, number>();
    const participantId = (name: string): number => {
      let id = participantIds.get(name);
      if (id === undefined) {
        db.run('INSERT OR IGNORE INTO participants (conversation_id, display_name) VALUES (?, ?)', [
          input.conversationId,
          name,
        ]);
        const [row] = db.all<{ id: number }>(
          'SELECT id FROM participants WHERE conversation_id = ? AND display_name = ?',
          [input.conversationId, name],
        );
        id = row.id;
        participantIds.set(name, id);
      }
      return id;
    };

    let added = 0;
    for (const m of input.messages) {
      added += db.run(
        `INSERT INTO messages (conversation_id, batch_id, fingerprint, sent_at, ordinal, type,
                               participant_id, body, media_sha256, media_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, fingerprint) DO NOTHING`,
        [
          input.conversationId,
          input.batchId,
          m.fingerprint,
          m.sentAt,
          m.ordinal,
          m.type,
          m.participantName === null ? null : participantId(m.participantName),
          m.body,
          m.mediaSha256,
          m.mediaName,
        ],
      );
    }
    const skipped = input.messages.length - added;
    db.run('UPDATE import_batches SET added_count = ?, skipped_count = ? WHERE id = ?', [added, skipped, input.batchId]);
    return { batchId: input.batchId, added, skipped };
  });
}

const MAX_PAGE = 1000;

interface MessageRow {
  id: number;
  sentAt: string;
  ordinal: number;
  type: StoredMessage['type'];
  participantName: string | null;
  body: string;
  mediaSha256: string | null;
  mediaName: string;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.sent_at AS sentAt, m.ordinal, m.type, p.display_name AS participantName,
         m.body, m.media_sha256 AS mediaSha256, m.media_name AS mediaName
    FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
   WHERE m.conversation_id = ?`;

/**
 * One page of a conversation in chronological order. Pass the last message's
 * position as `after` to get the next page (keyset pagination: stable even
 * while an overlapping import inserts older messages).
 */
export function listMessages(
  db: SqlDb,
  conversationId: string,
  options: { after?: MessageCursor; limit?: number } = {},
): StoredMessage[] {
  requireUuid(conversationId, 'conversation id');
  requireRecord(options, 'options');
  if (options.limit !== undefined && !Number.isFinite(options.limit)) invalid('limit must be a number');
  if (options.after !== undefined) {
    const a = requireRecord(options.after, 'after');
    if (!isLocalTimestamp(a.sentAt) || !Number.isSafeInteger(a.ordinal) || !Number.isSafeInteger(a.id)) {
      invalid('after must be { sentAt, ordinal, id }');
    }
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), MAX_PAGE);
  const order = 'ORDER BY m.sent_at, m.ordinal, m.id LIMIT ?';
  const { after } = options;
  return after
    ? db.all<MessageRow>(`${MESSAGE_SELECT} AND (m.sent_at, m.ordinal, m.id) > (?, ?, ?) ${order}`, [
        conversationId,
        after.sentAt,
        after.ordinal,
        after.id,
        limit,
      ])
    : db.all<MessageRow>(`${MESSAGE_SELECT} ${order}`, [conversationId, limit]);
}
