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
import {
  FieldError,
  isMimeType,
  normalizeConversationTitle,
  normalizeDescription,
  normalizeProfileName,
  normalizeRelationship,
} from '../domain/profile';
import { DbError } from './errors';
import { transaction, type SqlDb, type SqlValue } from './sql';

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

/** Runs a domain normalizer; its `FieldError` becomes an `invalid` request error. */
function field<T>(normalize: (value: unknown) => T, value: unknown): T {
  try {
    return normalize(value);
  } catch (error) {
    if (error instanceof FieldError) invalid(error.message);
    throw error;
  }
}

function notFound(what: string): never {
  throw new DbError('not-found', `${what} not found`);
}

/** Checks the shape of an optional photo reference before anything is written. */
function checkPhoto(photo: unknown): BlobRef | null {
  if (photo === null) return null;
  const b = requireRecord(photo, 'photo') as unknown as BlobRef;
  if (!isSha256Hex(b.sha256)) invalid('photo sha256 must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(b.size) || b.size < 0) invalid('photo size must be a non-negative integer');
  if (b.mime !== null && !isMimeType(b.mime)) invalid('photo mime must be a type/subtype media type or null');
  return b;
}

/**
 * Registers the photo as a blob row (the bytes are already stored by hash) so
 * `profiles.photo_sha256` can reference it. Runs inside the caller's transaction.
 */
function registerPhoto(db: SqlDb, photo: BlobRef | null): string | null {
  if (photo === null) return null;
  db.run('INSERT OR IGNORE INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [photo.sha256, photo.size, photo.mime]);
  return photo.sha256;
}

export interface CreateProfileInput {
  id: string;
  displayName: string;
  relationship?: string;
  description?: string;
  /** Photo already stored by hash; null or absent for none. */
  photo?: BlobRef | null;
  /** UTC instant (ISO 8601). */
  now: string;
}

const PROFILE_SELECT = `SELECT id, display_name AS displayName, relationship, description,
       photo_sha256 AS photoSha256, archived_at AS archivedAt,
       created_at AS createdAt, updated_at AS updatedAt
  FROM profiles`;

function readProfile(db: SqlDb, id: string): Profile {
  const [row] = db.all<Profile>(`${PROFILE_SELECT} WHERE id = ?`, [id]);
  if (!row) notFound('profile');
  return row;
}

export function createProfile(db: SqlDb, input: CreateProfileInput): Profile {
  requireRecord(input, 'params');
  requireUuid(input.id, 'profile id');
  requireString(input.now, 'now');
  const displayName = field(normalizeProfileName, input.displayName);
  const relationship = field(normalizeRelationship, input.relationship ?? '');
  const description = field(normalizeDescription, input.description ?? '');
  const photo = checkPhoto(input.photo ?? null);
  return transaction(db, () => {
    const photoSha256 = registerPhoto(db, photo);
    db.run(
      `INSERT INTO profiles (id, display_name, relationship, description, photo_sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, displayName, relationship, description, photoSha256, input.now, input.now],
    );
    return readProfile(db, input.id);
  });
}

export interface UpdateProfileInput {
  id: string;
  now: string;
  /** Absent fields are left as they are. */
  displayName?: string;
  relationship?: string;
  description?: string;
  /** A photo replaces the current one, null removes it, absent keeps it. */
  photo?: BlobRef | null;
}

export function updateProfile(db: SqlDb, input: UpdateProfileInput): Profile {
  requireRecord(input, 'params');
  requireUuid(input.id, 'profile id');
  requireString(input.now, 'now');
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (input.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(field(normalizeProfileName, input.displayName));
  }
  if (input.relationship !== undefined) {
    sets.push('relationship = ?');
    values.push(field(normalizeRelationship, input.relationship));
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(field(normalizeDescription, input.description));
  }
  const photo = input.photo === undefined ? undefined : checkPhoto(input.photo);
  return transaction(db, () => {
    readProfile(db, input.id);
    if (photo !== undefined) {
      sets.push('photo_sha256 = ?');
      values.push(registerPhoto(db, photo));
    }
    if (sets.length > 0) {
      db.run(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, input.now, input.id]);
    }
    return readProfile(db, input.id);
  });
}

export interface SetProfileArchivedInput {
  id: string;
  archived: boolean;
  now: string;
}

/** Archive or unarchive. Setting the state a profile already has changes nothing. */
export function setProfileArchived(db: SqlDb, input: SetProfileArchivedInput): Profile {
  requireRecord(input, 'params');
  requireUuid(input.id, 'profile id');
  requireString(input.now, 'now');
  if (typeof input.archived !== 'boolean') invalid('archived must be a boolean');
  return transaction(db, () => {
    const current = readProfile(db, input.id);
    if ((current.archivedAt !== null) !== input.archived) {
      db.run('UPDATE profiles SET archived_at = ?, updated_at = ? WHERE id = ?', [
        input.archived ? input.now : null,
        input.now,
        input.id,
      ]);
    }
    return readProfile(db, input.id);
  });
}

export function getProfile(db: SqlDb, id: string): Profile {
  requireUuid(id, 'profile id');
  return readProfile(db, id);
}

export type ProfileState = 'active' | 'archived' | 'all';

export function listProfiles(db: SqlDb, filter: { state?: ProfileState } = {}): Profile[] {
  requireRecord(filter, 'params');
  const state = filter.state ?? 'all';
  if (state !== 'active' && state !== 'archived' && state !== 'all') invalid('state must be active, archived or all');
  const where = state === 'all' ? '' : state === 'active' ? 'WHERE archived_at IS NULL' : 'WHERE archived_at IS NOT NULL';
  return db.all<Profile>(`${PROFILE_SELECT} ${where} ORDER BY created_at, id`);
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

function selectConversations(db: SqlDb, where: string, params: readonly SqlValue[]): ConversationSummary[] {
  const rows = db.all<ConversationRow>(
    `SELECT c.id, c.title, c.source, c.is_group, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT MIN(m.sent_at) FROM messages m WHERE m.conversation_id = c.id) AS first_message_at,
            (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
       FROM conversations c ${where}
      ORDER BY c.created_at, c.id`,
    params,
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

/** Conversations, optionally only those linked to `profileId`, oldest first. */
export function listConversations(db: SqlDb, filter: { profileId?: string } = {}): ConversationSummary[] {
  requireRecord(filter, 'params');
  if (filter.profileId !== undefined) requireUuid(filter.profileId, 'profile id');
  return filter.profileId === undefined
    ? selectConversations(db, '', [])
    : selectConversations(db, 'WHERE c.id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)', [
        filter.profileId,
      ]);
}

function readConversation(db: SqlDb, id: string): ConversationSummary {
  const [row] = selectConversations(db, 'WHERE c.id = ?', [id]);
  if (!row) notFound('conversation');
  return row;
}

function requireProfileExists(db: SqlDb, id: string): void {
  if (db.all('SELECT 1 FROM profiles WHERE id = ?', [id]).length === 0) notFound('profile');
}

export function renameConversation(db: SqlDb, input: { conversationId: string; title: string }): ConversationSummary {
  requireRecord(input, 'params');
  requireUuid(input.conversationId, 'conversation id');
  const title = field(normalizeConversationTitle, input.title);
  return transaction(db, () => {
    readConversation(db, input.conversationId);
    db.run('UPDATE conversations SET title = ? WHERE id = ?', [title, input.conversationId]);
    return readConversation(db, input.conversationId);
  });
}

export interface ConversationProfileInput {
  conversationId: string;
  profileId: string;
}

/** Adds a profile to the conversation's profiles (already linked: nothing changes). */
export function linkConversationProfile(db: SqlDb, input: ConversationProfileInput): ConversationSummary {
  requireRecord(input, 'params');
  requireUuid(input.conversationId, 'conversation id');
  requireUuid(input.profileId, 'profile id');
  return transaction(db, () => {
    readConversation(db, input.conversationId);
    requireProfileExists(db, input.profileId);
    db.run('INSERT OR IGNORE INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [
      input.conversationId,
      input.profileId,
    ]);
    return readConversation(db, input.conversationId);
  });
}

/**
 * Removes a profile from the conversation's profiles (not linked: nothing
 * changes). The conversation may end up with no profile; its messages stay.
 * `participants.profile_id` is not touched (see `moveConversation`).
 */
export function unlinkConversationProfile(db: SqlDb, input: ConversationProfileInput): ConversationSummary {
  requireRecord(input, 'params');
  requireUuid(input.conversationId, 'conversation id');
  requireUuid(input.profileId, 'profile id');
  return transaction(db, () => {
    readConversation(db, input.conversationId);
    db.run('DELETE FROM conversation_profiles WHERE conversation_id = ? AND profile_id = ?', [
      input.conversationId,
      input.profileId,
    ]);
    return readConversation(db, input.conversationId);
  });
}

export interface MoveConversationInput {
  conversationId: string;
  fromProfileId: string;
  toProfileId: string;
}

/**
 * Moves a conversation from one of its profiles to another: one transaction
 * that edits `conversation_profiles` rows only. Messages, media, participants
 * and `is_group` are never touched, so nothing is copied or re-imported.
 * `participants.profile_id` is deliberately left as it is: participant links
 * are independent of how a conversation is filed, so a move does not remap them
 * (remapping on move is a follow-up). The
 * target may be archived. Moving to the profile it is already under changes
 * nothing; a missing conversation, target, or source link is `not-found`.
 */
export function moveConversation(db: SqlDb, input: MoveConversationInput): ConversationSummary {
  requireRecord(input, 'params');
  requireUuid(input.conversationId, 'conversation id');
  requireUuid(input.fromProfileId, 'source profile id');
  requireUuid(input.toProfileId, 'target profile id');
  return transaction(db, () => {
    const conversation = readConversation(db, input.conversationId);
    requireProfileExists(db, input.toProfileId);
    if (!conversation.profileIds.includes(input.fromProfileId)) notFound('conversation link to the source profile');
    if (input.fromProfileId !== input.toProfileId) {
      db.run('INSERT OR IGNORE INTO conversation_profiles (conversation_id, profile_id) VALUES (?, ?)', [
        input.conversationId,
        input.toProfileId,
      ]);
      db.run('DELETE FROM conversation_profiles WHERE conversation_id = ? AND profile_id = ?', [
        input.conversationId,
        input.fromProfileId,
      ]);
    }
    return readConversation(db, input.conversationId);
  });
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
