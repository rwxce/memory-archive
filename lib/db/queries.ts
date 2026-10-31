import {
  isLocalTimestamp,
  MEDIA_MESSAGE_TYPES,
  isMessageType,
  isSha256Hex,
  isUuid,
  type BlobRef,
  type ConversationBounds,
  type ConversationDay,
  type ConversationMessage,
  type ConversationSummary,
  type MediaMessageType,
  type MessageCursor,
  type MessageSource,
  type Note,
  type NoteItem,
  type NoteTarget,
  type NewMessage,
  type NewParticipant,
  type Participant,
  type PersonMediaItem,
  type PersonTimelineMessage,
  type Profile,
  type StoredMessage,
} from '../domain/library';
import {
  FieldError,
  isMimeType,
  normalizeConversationTitle,
  normalizeDescription,
  normalizeNote,
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

export interface SetProfilePhotoInput {
  id: string;
  /** Photo already stored by hash; null removes it. */
  photo: BlobRef | null;
  now: string;
}

export interface SetProfilePhotoResult {
  profile: Profile;
  /** The replaced photo, when nothing else refers to it any more; its row is removed, the caller deletes the bytes. */
  unreferencedBlobs: string[];
}

/**
 * Replaces or removes a profile's photo in one transaction and releases the old photo's `blobs`
 * row when no message and no other profile uses it. Setting the photo a profile already has
 * changes nothing but `updatedAt`.
 */
export function setProfilePhoto(db: SqlDb, input: SetProfilePhotoInput): SetProfilePhotoResult {
  requireRecord(input, 'params');
  requireUuid(input.id, 'profile id');
  requireString(input.now, 'now');
  const photo = checkPhoto(input.photo);
  return transaction(db, () => {
    const before = readProfile(db, input.id);
    const photoSha256 = registerPhoto(db, photo);
    db.run('UPDATE profiles SET photo_sha256 = ?, updated_at = ? WHERE id = ?', [photoSha256, input.now, input.id]);
    const unreferencedBlobs: string[] = [];
    const old = before.photoSha256;
    if (old !== null && old !== photoSha256 && !isReferenced(db, old)) {
      db.run('DELETE FROM blobs WHERE sha256 = ?', [old]);
      unreferencedBlobs.push(old);
    }
    return { profile: readProfile(db, input.id), unreferencedBlobs };
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
  participants: NewParticipant[];
  /** The importer's stable key for "the same chat" (see `chatKeyOf`); '' when none. */
  sourceKey?: string;
  now: string;
}

/** Inserts the conversation, its profile links and participants. The caller owns the transaction. */
function insertConversation(db: SqlDb, input: CreateConversationInput): void {
  db.run('INSERT INTO conversations (id, title, source, source_key, is_group, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    input.id,
    input.title,
    input.source,
    input.sourceKey ?? '',
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
}

export function createConversation(db: SqlDb, input: CreateConversationInput): void {
  requireRecord(input, 'params');
  requireUuid(input.id, 'conversation id');
  requireString(input.title, 'title');
  requireString(input.source, 'source');
  requireString(input.now, 'now');
  if (input.sourceKey !== undefined) requireString(input.sourceKey, 'sourceKey');
  for (const profileId of requireArray(input.profileIds, 'profileIds')) requireUuid(profileId, 'profile id');
  for (const p of requireArray(input.participants, 'participants')) {
    requireString(requireRecord(p, 'participant').displayName, 'participant displayName');
  }
  transaction(db, () => insertConversation(db, input));
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
  return db
    .all<{ displayName: string; profileId: string | null; isMe: number }>(
      `SELECT display_name AS displayName, profile_id AS profileId, is_me AS isMe
         FROM participants WHERE conversation_id = ? ORDER BY id`,
      [conversationId],
    )
    .map((p) => ({ displayName: p.displayName, profileId: p.profileId, isMe: p.isMe === 1 }));
}

// ---------------------------------------------------------------- messages

export interface ImportMessagesInput {
  batchId: string;
  /** The conversation to add to; with `newConversation` it is created under this id. */
  conversationId: string;
  source: string;
  /** Free-text origin shown in history (e.g. the ZIP name). Untrusted. */
  sourceLabel: string;
  now: string;
  /** Media referenced by `messages`, already stored by hash. */
  blobs: BlobRef[];
  messages: NewMessage[];
  /**
   * The conversation does not exist yet: it is created in the same transaction as the
   * messages (so a failed import leaves no empty conversation) and the batch is marked as
   * its creator (undoing the batch removes it again once empty).
   */
  newConversation?: { title: string; sourceKey: string; isGroup: boolean; profileIds: string[] };
  /** The author the user said is themselves (a name as in `messages`); marks that participant. */
  meAuthor?: string | null;
}

export interface ImportMessagesResult {
  batchId: string;
  added: number;
  /** Messages already in the conversation (same fingerprint): not stored again. */
  skipped: number;
  /**
   * Blobs of `input.blobs` that no message (and no profile photo) refers to after the import,
   * e.g. media of messages that were already there. Their rows were removed in the same
   * transaction; the caller deletes the bytes.
   */
  unreferencedBlobs: string[];
}

function isReferenced(db: SqlDb, sha256: string): boolean {
  return (
    db.all('SELECT 1 FROM messages WHERE media_sha256 = ? LIMIT 1', [sha256]).length > 0 ||
    db.all('SELECT 1 FROM profiles WHERE photo_sha256 = ? LIMIT 1', [sha256]).length > 0
  );
}

/**
 * Stores one import in a single transaction. Idempotent: a message whose
 * fingerprint is already in the conversation is skipped, so re-importing the
 * same export, or a newer export that overlaps it, adds only what is new. If
 * anything fails, nothing is stored (not even the batch row or the conversation).
 */
export function importMessages(db: SqlDb, input: ImportMessagesInput): ImportMessagesResult {
  requireRecord(input, 'params');
  requireUuid(input.batchId, 'batch id');
  requireUuid(input.conversationId, 'conversation id');
  requireString(input.source, 'source');
  requireString(input.sourceLabel, 'sourceLabel');
  requireString(input.now, 'now');
  if (input.meAuthor !== undefined && input.meAuthor !== null) requireString(input.meAuthor, 'meAuthor');
  if (input.newConversation !== undefined) {
    const c = requireRecord(input.newConversation, 'newConversation');
    requireString(c.title, 'newConversation title');
    requireString(c.sourceKey, 'newConversation sourceKey');
    for (const profileId of requireArray(c.profileIds, 'newConversation profileIds')) requireUuid(profileId, 'profile id');
  }
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
    const created = input.newConversation !== undefined;
    if (input.newConversation) {
      insertConversation(db, {
        id: input.conversationId,
        title: input.newConversation.title,
        source: input.source,
        sourceKey: input.newConversation.sourceKey,
        isGroup: input.newConversation.isGroup,
        profileIds: input.newConversation.profileIds,
        participants: [],
        now: input.now,
      });
    } else if (db.all('SELECT 1 FROM conversations WHERE id = ?', [input.conversationId]).length === 0) {
      notFound('conversation');
    }
    db.run(
      `INSERT INTO import_batches (id, conversation_id, source, source_label, created_at, created_conversation)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.batchId, input.conversationId, input.source, input.sourceLabel, input.now, created ? 1 : 0],
    );
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
    if (input.meAuthor !== undefined && input.meAuthor !== null) {
      db.run('UPDATE participants SET is_me = (id = ?) WHERE conversation_id = ?', [
        participantId(input.meAuthor),
        input.conversationId,
      ]);
    }
    const skipped = input.messages.length - added;
    db.run('UPDATE import_batches SET added_count = ?, skipped_count = ? WHERE id = ?', [added, skipped, input.batchId]);

    const unreferencedBlobs: string[] = [];
    for (const sha256 of new Set(input.blobs.map((b) => b.sha256))) {
      if (isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return { batchId: input.batchId, added, skipped, unreferencedBlobs };
  });
}

/** Max bound parameters per statement (SQLite's default limit is 32766; stay well below). */
const CHUNK = 500;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface FindExistingFingerprintsInput {
  conversationId: string;
  fingerprints: string[];
}

/** Which of `fingerprints` are already stored in the conversation (so their media need not be read). */
export function findExistingFingerprints(db: SqlDb, input: FindExistingFingerprintsInput): string[] {
  requireRecord(input, 'params');
  requireUuid(input.conversationId, 'conversation id');
  const found: string[] = [];
  for (const group of chunks(requireArray(input.fingerprints, 'fingerprints') as string[])) {
    for (const f of group) if (!isSha256Hex(f)) invalid('fingerprint must be 64 lowercase hex characters');
    found.push(
      ...db
        .all<{ fingerprint: string }>(
          `SELECT fingerprint FROM messages WHERE conversation_id = ? AND fingerprint IN (${group.map(() => '?').join(',')})`,
          [input.conversationId, ...group],
        )
        .map((r) => r.fingerprint),
    );
  }
  return found;
}

export interface ImportCandidatesInput {
  source: string;
  /** The export's stable chat key; '' never matches by key. */
  sourceKey: string;
  /** The profiles the import is for; empty = only conversations not filed under any profile. */
  profileIds: string[];
  /** A sample of the export's fingerprints, to spot a chat renamed since its last import. */
  sampleFingerprints: string[];
}

export interface ImportCandidate {
  id: string;
  title: string;
  messageCount: number;
  /** How many of the sampled fingerprints this conversation already holds. */
  overlap: number;
}

export interface ImportCandidates {
  /** In scope and with the same `source_key`. */
  keyed: ImportCandidate[];
  /** In scope, other key, but already holding some of the sampled fingerprints. */
  overlapping: ImportCandidate[];
}

/**
 * The conversations an import could belong to. Scope: same `source`, filed under one of
 * `profileIds` (or under none when the list is empty). Nothing here decides; the use case does.
 */
export function findImportCandidates(db: SqlDb, input: ImportCandidatesInput): ImportCandidates {
  requireRecord(input, 'params');
  requireString(input.source, 'source');
  requireString(input.sourceKey, 'sourceKey');
  for (const id of requireArray(input.profileIds, 'profileIds')) requireUuid(id, 'profile id');
  for (const f of requireArray(input.sampleFingerprints, 'sampleFingerprints')) {
    if (!isSha256Hex(f)) invalid('fingerprint must be 64 lowercase hex characters');
  }
  const profileIds = [...new Set(input.profileIds)];
  const scope =
    profileIds.length === 0
      ? 'NOT EXISTS (SELECT 1 FROM conversation_profiles cp WHERE cp.conversation_id = c.id)'
      : `EXISTS (SELECT 1 FROM conversation_profiles cp WHERE cp.conversation_id = c.id AND cp.profile_id IN (${profileIds.map(() => '?').join(',')}))`;
  const rows = db.all<{ id: string; title: string; sourceKey: string; messageCount: number }>(
    `SELECT c.id, c.title, c.source_key AS sourceKey,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount
       FROM conversations c WHERE c.source = ? AND ${scope} ORDER BY c.created_at, c.id`,
    [input.source, ...profileIds],
  );
  const keyed = input.sourceKey === '' ? [] : rows.filter((r) => r.sourceKey === input.sourceKey);
  const keyedIds = new Set(keyed.map((r) => r.id));
  const hits = new Map<string, number>();
  if (rows.length > 0) {
    for (const group of chunks([...new Set(input.sampleFingerprints)])) {
      for (const some of chunks(rows, 50)) {
        for (const r of db.all<{ conversationId: string; n: number }>(
          `SELECT conversation_id AS conversationId, COUNT(*) AS n FROM messages
            WHERE conversation_id IN (${some.map(() => '?').join(',')})
              AND fingerprint IN (${group.map(() => '?').join(',')})
            GROUP BY conversation_id`,
          [...some.map((o) => o.id), ...group],
        )) {
          hits.set(r.conversationId, (hits.get(r.conversationId) ?? 0) + r.n);
        }
      }
    }
  }
  const toCandidate = (r: (typeof rows)[number]): ImportCandidate => ({
    id: r.id,
    title: r.title,
    messageCount: r.messageCount,
    overlap: hits.get(r.id) ?? 0,
  });
  return {
    keyed: keyed.map(toCandidate),
    overlapping: rows.filter((r) => !keyedIds.has(r.id) && (hits.get(r.id) ?? 0) > 0).map(toCandidate),
  };
}

export interface UndoImportBatchResult {
  /** False when no such batch exists (already undone, or never there): nothing was changed. */
  found: boolean;
  removedMessages: number;
  /** The batch had created its conversation and nothing else was left in it: it is gone too. */
  removedConversation: boolean;
  /** Blobs no message or profile photo refers to any more; rows removed, the caller deletes the bytes. */
  unreferencedBlobs: string[];
}

/**
 * Removes an import batch in one transaction: its messages, the participants only it brought
 * (no remaining messages, not linked to a profile, not marked "me"), the batch row, the
 * conversation if the batch created it and it is now empty, and the `blobs` rows nothing
 * refers to any more. Blobs shared with another batch, conversation or a profile photo stay.
 * Idempotent: a second call finds nothing and changes nothing.
 */
export function undoImportBatch(db: SqlDb, batchId: string): UndoImportBatchResult {
  requireUuid(batchId, 'batch id');
  return transaction(db, () => {
    const [batch] = db.all<{ conversationId: string; created: number }>(
      'SELECT conversation_id AS conversationId, created_conversation AS created FROM import_batches WHERE id = ?',
      [batchId],
    );
    if (!batch) return { found: false, removedMessages: 0, removedConversation: false, unreferencedBlobs: [] };

    const blobs = db
      .all<{ sha256: string }>('SELECT DISTINCT media_sha256 AS sha256 FROM messages WHERE batch_id = ? AND media_sha256 IS NOT NULL', [batchId])
      .map((r) => r.sha256);
    const participants = db
      .all<{ id: number }>('SELECT DISTINCT participant_id AS id FROM messages WHERE batch_id = ? AND participant_id IS NOT NULL', [batchId])
      .map((r) => r.id);
    const removedMessages = db.run('DELETE FROM messages WHERE batch_id = ?', [batchId]);
    for (const id of participants) {
      db.run(
        `DELETE FROM participants WHERE id = ? AND profile_id IS NULL AND is_me = 0
            AND NOT EXISTS (SELECT 1 FROM messages WHERE participant_id = participants.id)`,
        [id],
      );
    }
    const [{ n }] = db.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [batch.conversationId]);
    const removedConversation = batch.created === 1 && n === 0;
    if (removedConversation) {
      // Its other batches added nothing (no message is left), so they go with it.
      db.run('DELETE FROM import_batches WHERE conversation_id = ?', [batch.conversationId]);
      db.run('DELETE FROM conversations WHERE id = ?', [batch.conversationId]);
    } else {
      db.run('DELETE FROM import_batches WHERE id = ?', [batchId]);
    }
    const unreferencedBlobs: string[] = [];
    for (const sha256 of blobs) {
      if (isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return { found: true, removedMessages, removedConversation, unreferencedBlobs };
  });
}

export interface ImportBatchCursor {
  createdAt: string;
  id: string;
}

export interface ListImportBatchesInput {
  conversationId?: string;
  /** Only batches whose conversation is filed under this profile. */
  profileId?: string;
  /** The last batch of the previous page (keyset pagination, newest first). */
  before?: ImportBatchCursor;
  /** Default 50, at most 200. */
  limit?: number;
}

/** One import as the history shows it. */
export interface ImportBatchRow {
  id: string;
  /** UTC instant of the import. */
  createdAt: string;
  source: string;
  /** The file name the import came from. Untrusted, display only. */
  sourceLabel: string;
  /** Messages stored by this import when it ran. */
  messagesAdded: number;
  /** Messages it found already stored. */
  messagesSkipped: number;
  /** Messages of this batch still in the archive (an undo of another batch can remove shared ones). */
  messagesPresent: number;
  /** Of those, how many carry a media file. Per-batch media added/skipped counts are not recorded. */
  mediaPresent: number;
  createdConversation: boolean;
  /** Null only if the conversation row is gone. */
  conversationId: string | null;
  conversationTitle: string | null;
  /** Profiles the conversation is filed under now. */
  profileIds: string[];
  /** Undo would remove something (`messagesPresent > 0`). */
  canUndo: boolean;
}

const MAX_BATCH_PAGE = 200;

/**
 * Import history, newest first. A batch exists until it is undone (undo deletes the row), so
 * there are no "undone" entries. A re-import that added nothing and created nothing is not
 * listed (it changed nothing; the row stays so the import result keeps a valid batch id).
 * Counts of present messages come from `messages_by_batch`, one index range per listed row.
 */
export function listImportBatches(db: SqlDb, input: ListImportBatchesInput = {}): ImportBatchRow[] {
  requireRecord(input, 'params');
  if (input.conversationId !== undefined) requireUuid(input.conversationId, 'conversation id');
  if (input.profileId !== undefined) requireUuid(input.profileId, 'profile id');
  if (input.limit !== undefined && !Number.isFinite(input.limit)) invalid('limit must be a number');
  if (input.before !== undefined) {
    const b = requireRecord(input.before, 'before');
    if (typeof b.createdAt !== 'string' || !isUuid(b.id)) invalid('before must be { createdAt, id }');
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_BATCH_PAGE);
  const where: string[] = ['(b.added_count > 0 OR b.created_conversation = 1)'];
  const params: SqlValue[] = [];
  if (input.conversationId !== undefined) {
    where.push('b.conversation_id = ?');
    params.push(input.conversationId);
  }
  if (input.profileId !== undefined) {
    where.push('b.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)');
    params.push(input.profileId);
  }
  if (input.before !== undefined) {
    where.push('(b.created_at, b.id) < (?, ?)');
    params.push(input.before.createdAt, input.before.id);
  }
  const rows = db.all<{
    id: string;
    createdAt: string;
    source: string;
    sourceLabel: string;
    messagesAdded: number;
    messagesSkipped: number;
    messagesPresent: number;
    mediaPresent: number;
    created: number;
    conversationId: string | null;
    conversationTitle: string | null;
  }>(
    `SELECT b.id, b.created_at AS createdAt, b.source, b.source_label AS sourceLabel,
            b.added_count AS messagesAdded, b.skipped_count AS messagesSkipped,
            (SELECT COUNT(*) FROM messages m WHERE m.batch_id = b.id) AS messagesPresent,
            (SELECT COUNT(*) FROM messages m WHERE m.batch_id = b.id AND m.media_sha256 IS NOT NULL) AS mediaPresent,
            b.created_conversation AS created, c.id AS conversationId, c.title AS conversationTitle
       FROM import_batches b LEFT JOIN conversations c ON c.id = b.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    [...params, limit],
  );
  const profilesOf = new Map<string, string[]>();
  const conversationIds = [...new Set(rows.flatMap((r) => (r.conversationId === null ? [] : [r.conversationId])))];
  for (const ids of chunks(conversationIds)) {
    const links = db.all<{ conversation_id: string; profile_id: string }>(
      `SELECT conversation_id, profile_id FROM conversation_profiles
        WHERE conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY profile_id`,
      ids,
    );
    for (const l of links) {
      const list = profilesOf.get(l.conversation_id);
      if (list) list.push(l.profile_id);
      else profilesOf.set(l.conversation_id, [l.profile_id]);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    source: r.source,
    sourceLabel: r.sourceLabel,
    messagesAdded: r.messagesAdded,
    messagesSkipped: r.messagesSkipped,
    messagesPresent: r.messagesPresent,
    mediaPresent: r.mediaPresent,
    createdConversation: r.created === 1,
    conversationId: r.conversationId,
    conversationTitle: r.conversationTitle,
    profileIds: (r.conversationId !== null && profilesOf.get(r.conversationId)) || [],
    canUndo: r.messagesPresent > 0,
  }));
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

// ------------------------------------------------- conversation view reads

/** Most messages one window returns; callers ask for less and page by offset. */
export const MAX_WINDOW = 500;
/** Most days `listConversationDays` returns (a century); a chat cannot get near it. */
export const MAX_DAYS = 36_600;

export function requireConversation(db: SqlDb, conversationId: unknown): string {
  const id = requireUuid(conversationId, 'conversation id');
  if (db.all('SELECT 1 FROM conversations WHERE id = ?', [id]).length === 0) notFound('conversation');
  return id;
}

/** True for a real calendar date written `YYYY-MM-DD`. */
function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/** Message count and first/last time of a conversation. `not-found` when it does not exist. */
export function getConversationBounds(db: SqlDb, conversationId: string): ConversationBounds {
  const id = requireConversation(db, conversationId);
  // min/max over the (conversation, sent_at, ...) index are two index probes, count is a covering range scan.
  const [row] = db.all<{ count: number; first: string | null; last: string | null }>(
    `SELECT count(*) AS count, min(sent_at) AS first, max(sent_at) AS last FROM messages WHERE conversation_id = ?`,
    [id],
  );
  return { count: row.count, firstSentAt: row.first, lastSentAt: row.last };
}

export function countMessages(db: SqlDb, conversationId: string): number {
  return getConversationBounds(db, conversationId).count;
}

/** A window row as SQLite returns it: the flags are 0 / 1 and `isSystem` is derived. */
export type WindowRow<T extends ConversationMessage> = Omit<T, 'isMe' | 'isSystem' | 'isFavorite' | 'hasNote'> & { isMe: number; isFavorite: number; hasNote: number };

export function toWindowMessage<T extends ConversationMessage>(m: WindowRow<T>): T {
  return { ...m, isMe: m.isMe === 1, isSystem: m.type === 'system', isFavorite: m.isFavorite === 1, hasNote: m.hasNote === 1 } as unknown as T;
}

/** The ids of one window, straight off `messages_timeline` (covering: no table lookups, no sort). */
export const WINDOW_IDS_SQL = `SELECT id FROM messages WHERE conversation_id = ? ORDER BY sent_at, ordinal, id LIMIT ? OFFSET ?`;

/** Window ids first, then only those rows are joined: the OFFSET skip never touches the table. */
export const MESSAGE_WINDOW_SQL = `
  SELECT m.id, m.sent_at AS sentAt, m.ordinal, m.type, p.display_name AS participantName,
         COALESCE(p.is_me, 0) AS isMe, m.body, m.media_sha256 AS mediaSha256,
         m.media_name AS mediaName, b.mime AS mediaMime, f.fingerprint IS NOT NULL AS isFavorite,
         nt.fingerprint IS NOT NULL AS hasNote
    FROM (${WINDOW_IDS_SQL}) w
    JOIN messages m ON m.id = w.id
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN blobs b ON b.sha256 = m.media_sha256
    LEFT JOIN favorites f ON f.conversation_id = m.conversation_id AND f.fingerprint = m.fingerprint
    LEFT JOIN notes nt ON nt.conversation_id = m.conversation_id AND nt.fingerprint = m.fingerprint
   ORDER BY m.sent_at, m.ordinal, m.id`;

/**
 * `limit` messages starting at position `offset` in chronological order (sent_at, ordinal, id).
 * `limit` is clamped to 1..MAX_WINDOW; an offset past the end gives an empty window. Positions
 * shift when an import adds older messages (or one is undone): a view that stays open keeps the positions it read, so it shows the old window until it is reopened.
 */
export function getMessageWindow(db: SqlDb, conversationId: string, offset: number, limit: number): ConversationMessage[] {
  const id = requireConversation(db, conversationId);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db
    .all<WindowRow<ConversationMessage>>(MESSAGE_WINDOW_SQL, [id, n, offset])
    .map(toWindowMessage);
}

/**
 * Offset of the first message on or after the local date `YYYY-MM-DD`, or `null` when every
 * message is earlier (nothing to jump to). A date before the first message gives 0.
 */
export function findMessageOffsetByDate(db: SqlDb, conversationId: string, date: string): number | null {
  const id = requireConversation(db, conversationId);
  if (!isLocalDate(date)) invalid('date must be a calendar date YYYY-MM-DD');
  const from = `${date}T00:00:00`;
  // Both are range scans on messages_timeline: the count stops at the date, the probe at one row.
  if (db.all('SELECT 1 FROM messages WHERE conversation_id = ? AND sent_at >= ? LIMIT 1', [id, from]).length === 0) return null;
  const [row] = db.all<{ before: number }>('SELECT count(*) AS before FROM messages WHERE conversation_id = ? AND sent_at < ?', [id, from]);
  return row.before;
}

/**
 * Offset of one message in the conversation's order (sent_at, ordinal, id): how many messages come
 * strictly before it. `null` when the id is not a message of this conversation (so a stale link
 * never lands on the wrong place). The comparison is spelled out so it is one range scan on messages_timeline.
 */
export function findMessageOffsetById(db: SqlDb, conversationId: string, messageId: number): number | null {
  const id = requireConversation(db, conversationId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) invalid('message id must be a positive integer');
  const [at] = db.all<{ sentAt: string; ordinal: number }>('SELECT sent_at AS sentAt, ordinal FROM messages WHERE id = ? AND conversation_id = ?', [messageId, id]);
  if (!at) return null;
  const [row] = db.all<{ before: number }>(
    `SELECT count(*) AS before FROM messages WHERE conversation_id = ?
        AND (sent_at < ? OR (sent_at = ? AND (ordinal < ? OR (ordinal = ? AND id < ?))))`,
    [id, at.sentAt, at.sentAt, at.ordinal, at.ordinal, messageId],
  );
  return row.before;
}

/**
 * Every local day with messages, in order, with its count and the offset of its first message
 * (the running total of the days before it). One pass over the index; at most MAX_DAYS rows.
 */
export function listConversationDays(db: SqlDb, conversationId: string): ConversationDay[] {
  const id = requireConversation(db, conversationId);
  return db.all<ConversationDay>(
    `SELECT date, count, SUM(count) OVER (ORDER BY date) - count AS firstOffset
       FROM (SELECT substr(sent_at, 1, 10) AS date, count(*) AS count
               FROM messages WHERE conversation_id = ? GROUP BY date)
      ORDER BY date LIMIT ?`,
    [id, MAX_DAYS],
  );
}

/**
 * Where a message came from: the import batch that first added it (a re-import skips duplicates,
 * so the message stays with the first batch). The pair is checked, so an id of another
 * conversation is `not-found`, never revealed. `invalid` for a malformed id.
 */
export function getMessageSource(db: SqlDb, conversationId: string, messageId: number): MessageSource {
  const id = requireUuid(conversationId, 'conversation id');
  if (!Number.isSafeInteger(messageId) || messageId < 1) invalid('message id must be a positive integer');
  const [row] = db.all<Omit<MessageSource, 'messageId'>>(
    `SELECT b.source AS source, b.source_label AS sourceLabel, b.created_at AS importedAt, b.id AS batchId
       FROM messages m JOIN import_batches b ON b.id = m.batch_id
      WHERE m.id = ? AND m.conversation_id = ?`,
    [messageId, id],
  );
  if (!row) notFound('message');
  return { messageId, ...row };
}

// ------------------------------------------------------ a person's media list

/** Validated, de-duplicated media types of a request; `invalid` when empty or not a media type. */
function requireMediaKinds(kinds: unknown): MediaMessageType[] {
  const list = requireArray(kinds, 'kinds');
  if (list.length === 0) invalid('kinds must not be empty');
  for (const k of list) {
    if (typeof k !== 'string' || !(MEDIA_MESSAGE_TYPES as readonly string[]).includes(k)) invalid('kinds must be media message types');
  }
  return [...new Set(list as MediaMessageType[])];
}

/** The person's messages with a stored file of the given types, over every conversation filed under them. */
const PERSON_MEDIA_WHERE = (kinds: readonly unknown[]) =>
  `m.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)
   AND m.media_sha256 IS NOT NULL AND m.type IN (${kinds.map(() => '?').join(',')})`;

/** How many media messages of those types the person has. `not-found` for an unknown profile. */
export function countPersonMedia(db: SqlDb, profileId: string, kinds: readonly MediaMessageType[]): number {
  const id = requireUuid(profileId, 'profile id');
  const types = requireMediaKinds(kinds);
  requireProfileExists(db, id);
  const [row] = db.all<{ n: number }>(`SELECT count(*) AS n FROM messages m WHERE ${PERSON_MEDIA_WHERE(types)}`, [id, ...types]);
  return row.n;
}

/**
 * `limit` media messages of the person starting at position `offset`, oldest first across all their
 * conversations, in the total order (sent_at, ordinal, id) so equal timestamps never reorder.
 * `limit` is clamped to 1..MAX_WINDOW; an offset past the end gives an empty list. Works for an
 * archived profile. Ids are picked first and only that page is joined to authors, blobs and titles.
 */
export function listPersonMedia(
  db: SqlDb,
  profileId: string,
  kinds: readonly MediaMessageType[],
  offset: number,
  limit: number,
): PersonMediaItem[] {
  const id = requireUuid(profileId, 'profile id');
  const types = requireMediaKinds(kinds);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  requireProfileExists(db, id);
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db
    .all<Omit<PersonMediaItem, 'isMe' | 'isFavorite'> & { isMe: number; isFavorite: number }>(
      `SELECT m.id, m.conversation_id AS conversationId, c.title AS conversationTitle, m.sent_at AS sentAt,
              m.type, p.display_name AS participantName, COALESCE(p.is_me, 0) AS isMe, m.body,
              m.media_sha256 AS mediaSha256, m.media_name AS mediaName, b.mime AS mediaMime,
              f.fingerprint IS NOT NULL AS isFavorite
         FROM (SELECT m.id FROM messages m WHERE ${PERSON_MEDIA_WHERE(types)}
                ORDER BY m.sent_at, m.ordinal, m.id LIMIT ? OFFSET ?) w
         JOIN messages m ON m.id = w.id
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN participants p ON p.id = m.participant_id
         LEFT JOIN blobs b ON b.sha256 = m.media_sha256
         LEFT JOIN favorites f ON f.conversation_id = m.conversation_id AND f.fingerprint = m.fingerprint
        ORDER BY m.sent_at, m.ordinal, m.id`,
      [id, ...types, n, offset],
    )
    .map((m) => ({ ...m, isMe: m.isMe === 1, isFavorite: m.isFavorite === 1 }));
}

// ----------------------------------------------------- a person's combined timeline

/** Messages of every conversation linked to the profile (archived or not); unlinked ones are out. */
const TIMELINE_MEMBER = `m.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)`;

export function requireProfile(db: SqlDb, profileId: unknown): string {
  const id = requireUuid(profileId, 'profile id');
  requireProfileExists(db, id);
  return id;
}

/** Message count and first/last time over all the person's conversations (`null` bounds when none). */
export function getPersonTimelineBounds(db: SqlDb, profileId: string): ConversationBounds {
  const id = requireProfile(db, profileId);
  const [row] = db.all<{ count: number; first: string | null; last: string | null }>(
    `SELECT count(*) AS count, min(sent_at) AS first, max(sent_at) AS last FROM messages m WHERE ${TIMELINE_MEMBER}`,
    [id],
  );
  return { count: row.count, firstSentAt: row.first, lastSentAt: row.last };
}

/**
 * The ids of one timeline window. Total order `(sent_at, ordinal, conversation_id, id)`: it is
 * the order of `messages_by_time` (v4), named here because the planner prefers a sort of every
 * linked conversation, which is slower; ties on time never reorder between calls.
 */
export const TIMELINE_IDS_SQL = `SELECT m.id FROM messages m INDEXED BY messages_by_time WHERE ${TIMELINE_MEMBER}
   ORDER BY m.sent_at, m.ordinal, m.conversation_id, m.id LIMIT ? OFFSET ?`;

export const TIMELINE_WINDOW_SQL = `
  SELECT m.id, m.conversation_id AS conversationId, c.title AS conversationTitle, m.sent_at AS sentAt,
         m.ordinal, m.type, p.display_name AS participantName, COALESCE(p.is_me, 0) AS isMe, m.body,
         m.media_sha256 AS mediaSha256, m.media_name AS mediaName, b.mime AS mediaMime,
         f.fingerprint IS NOT NULL AS isFavorite, nt.fingerprint IS NOT NULL AS hasNote
    FROM (${TIMELINE_IDS_SQL}) w
    JOIN messages m ON m.id = w.id
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN participants p ON p.id = m.participant_id
    LEFT JOIN blobs b ON b.sha256 = m.media_sha256
    LEFT JOIN favorites f ON f.conversation_id = m.conversation_id AND f.fingerprint = m.fingerprint
    LEFT JOIN notes nt ON nt.conversation_id = m.conversation_id AND nt.fingerprint = m.fingerprint
   ORDER BY m.sent_at, m.ordinal, m.conversation_id, m.id`;

/**
 * `limit` messages from position `offset` of the person's merged timeline, same clamp and
 * semantics as `getMessageWindow` (limit 1..MAX_WINDOW, past the end is empty). A conversation
 * linked to two people is in both timelines. `not-found` for an unknown profile.
 */
export function getPersonTimelineWindow(db: SqlDb, profileId: string, offset: number, limit: number): PersonTimelineMessage[] {
  const id = requireProfile(db, profileId);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db
    .all<WindowRow<PersonTimelineMessage>>(TIMELINE_WINDOW_SQL, [id, n, offset])
    .map(toWindowMessage);
}

/** Offset of the first timeline message on or after the local date, `null` when all are earlier. */
export function findPersonTimelineOffsetByDate(db: SqlDb, profileId: string, date: string): number | null {
  const id = requireProfile(db, profileId);
  if (!isLocalDate(date)) invalid('date must be a calendar date YYYY-MM-DD');
  const from = `${date}T00:00:00`;
  if (db.all(`SELECT 1 FROM messages m WHERE ${TIMELINE_MEMBER} AND m.sent_at >= ? LIMIT 1`, [id, from]).length === 0) return null;
  const [row] = db.all<{ before: number }>(`SELECT count(*) AS before FROM messages m WHERE ${TIMELINE_MEMBER} AND m.sent_at < ?`, [id, from]);
  return row.before;
}

/**
 * Offset of one message in the person's timeline order (sent_at, ordinal, conversation_id, id), `null`
 * when it is not in a conversation linked to the profile.
 */
export function findPersonTimelineOffsetById(db: SqlDb, profileId: string, messageId: number): number | null {
  const id = requireProfile(db, profileId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) invalid('message id must be a positive integer');
  const [at] = db.all<{ sentAt: string; ordinal: number; conv: string }>(
    `SELECT m.sent_at AS sentAt, m.ordinal, m.conversation_id AS conv FROM messages m WHERE ${TIMELINE_MEMBER} AND m.id = ?`,
    [id, messageId],
  );
  if (!at) return null;
  const [row] = db.all<{ before: number }>(
    `SELECT count(*) AS before FROM messages m WHERE ${TIMELINE_MEMBER}
        AND (m.sent_at < ? OR (m.sent_at = ? AND (m.ordinal < ? OR (m.ordinal = ? AND (m.conversation_id < ? OR (m.conversation_id = ? AND m.id < ?))))))`,
    [id, at.sentAt, at.sentAt, at.ordinal, at.ordinal, at.conv, at.conv, messageId],
  );
  return row.before;
}

/** Every local day with timeline messages, with its count and the offset of its first message. */
export function listPersonTimelineDays(db: SqlDb, profileId: string): ConversationDay[] {
  const id = requireProfile(db, profileId);
  return db.all<ConversationDay>(
    `SELECT date, count, SUM(count) OVER (ORDER BY date) - count AS firstOffset
       FROM (SELECT substr(m.sent_at, 1, 10) AS date, count(*) AS count
               FROM messages m WHERE ${TIMELINE_MEMBER} GROUP BY date)
      ORDER BY date LIMIT ?`,
    [id, MAX_DAYS],
  );
}

// --------------------------------------------------------------- favorites

export interface SetFavoriteInput {
  conversationId: string;
  /** The local message id the screen holds; resolved to the fingerprint here and never stored. */
  messageId: number;
  favorite: boolean;
  /** UTC instant (ISO 8601); recorded when the favorite is created. */
  now: string;
}

/**
 * Marks or unmarks a message as a favorite. The favorite is stored by `(conversation, fingerprint)`,
 * so it survives backup / restore and merge; the message id is only how the screen names the row.
 * The pair is checked: a message of another conversation is `not-found`. Idempotent: favoriting
 * twice is one row (the first `created_at` stays), unfavoriting a non-favorite changes nothing.
 */
export function setFavorite(db: SqlDb, input: SetFavoriteInput): { messageId: number; isFavorite: boolean } {
  requireRecord(input, 'params');
  const conversationId = requireUuid(input.conversationId, 'conversation id');
  if (!Number.isSafeInteger(input.messageId) || input.messageId < 1) invalid('message id must be a positive integer');
  if (typeof input.favorite !== 'boolean') invalid('favorite must be a boolean');
  requireString(input.now, 'now');
  return transaction(db, () => {
    const [row] = db.all<{ fingerprint: string }>('SELECT fingerprint FROM messages WHERE id = ? AND conversation_id = ?', [
      input.messageId,
      conversationId,
    ]);
    if (!row) notFound('message');
    if (input.favorite) {
      db.run('INSERT OR IGNORE INTO favorites (conversation_id, fingerprint, created_at) VALUES (?, ?, ?)', [
        conversationId,
        row.fingerprint,
        input.now,
      ]);
    } else {
      db.run('DELETE FROM favorites WHERE conversation_id = ? AND fingerprint = ?', [conversationId, row.fingerprint]);
    }
    return { messageId: input.messageId, isFavorite: input.favorite };
  });
}

export interface FavoriteScope {
  /** Only favorites in conversations linked to this person. */
  profileId?: string;
  /** Only favorites of this conversation. At most one of the two; none = the whole archive. */
  conversationId?: string;
}

/** Validates the scope and returns its SQL condition over `f` (favorites) and its parameters. */
function favoriteScope(db: SqlDb, scope: FavoriteScope | undefined): { where: string; params: SqlValue[] } {
  const s = scope === undefined ? {} : requireRecord(scope, 'scope');
  if (s.profileId !== undefined && s.conversationId !== undefined) invalid('scope takes a profile or a conversation, not both');
  if (s.profileId !== undefined) {
    const id = requireProfile(db, s.profileId);
    return { where: 'AND f.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?)', params: [id] };
  }
  if (s.conversationId !== undefined) return { where: 'AND f.conversation_id = ?', params: [requireConversation(db, s.conversationId)] };
  return { where: '', params: [] };
}

/**
 * How many favorites are visible in the scope. A favorite whose message is gone (undone import)
 * is dormant and not counted. `not-found` for an unknown profile or conversation.
 */
export function countFavorites(db: SqlDb, scope?: FavoriteScope): number {
  const { where, params } = favoriteScope(db, scope);
  const [row] = db.all<{ n: number }>(
    `SELECT count(*) AS n FROM favorites f
       CROSS JOIN messages m ON m.conversation_id = f.conversation_id AND m.fingerprint = f.fingerprint
      WHERE 1 = 1 ${where}`,
    params,
  );
  return row.n;
}

/**
 * `limit` favorite messages from position `offset`, oldest first in the timeline's total order
 * `(sent_at, ordinal, conversation_id, id)`, each with its conversation (same shape as a person
 * timeline message, `isFavorite` always true). Limit clamped to 1..MAX_WINDOW; past the end is
 * empty. The favorites are few, so they drive the query (`CROSS JOIN` pins the order: left to
 * itself the planner walks every message in time order, probing favorites, which is O(archive))
 * and the few matches are sorted; only the page is joined to authors, blobs and titles.
 */
export function listFavorites(db: SqlDb, scope: FavoriteScope | undefined, offset: number, limit: number): PersonTimelineMessage[] {
  const { where, params } = favoriteScope(db, scope);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db
    .all<WindowRow<PersonTimelineMessage>>(
      `SELECT m.id, m.conversation_id AS conversationId, c.title AS conversationTitle, m.sent_at AS sentAt,
              m.ordinal, m.type, p.display_name AS participantName, COALESCE(p.is_me, 0) AS isMe, m.body,
              m.media_sha256 AS mediaSha256, m.media_name AS mediaName, b.mime AS mediaMime, 1 AS isFavorite,
              nt.fingerprint IS NOT NULL AS hasNote
         FROM (SELECT m.id FROM favorites f
                 CROSS JOIN messages m ON m.conversation_id = f.conversation_id AND m.fingerprint = f.fingerprint
                WHERE 1 = 1 ${where}
                ORDER BY m.sent_at, m.ordinal, m.conversation_id, m.id LIMIT ? OFFSET ?) w
         JOIN messages m ON m.id = w.id
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN participants p ON p.id = m.participant_id
         LEFT JOIN blobs b ON b.sha256 = m.media_sha256
         LEFT JOIN notes nt ON nt.conversation_id = m.conversation_id AND nt.fingerprint = m.fingerprint
        ORDER BY m.sent_at, m.ordinal, m.conversation_id, m.id`,
      [...params, n, offset],
    )
    .map(toWindowMessage);
}

// ------------------------------------------------------------------- notes

export interface SetNoteInput {
  target: NoteTarget;
  /** The text; trimmed. Empty (after trimming) deletes the note. */
  body: string;
  /** UTC instant (ISO 8601); recorded as `created_at` / `updated_at`. */
  now: string;
}

/** The target as stored: the message id of the screen is resolved to the fingerprint here. */
interface NoteKey {
  kind: NoteTarget['kind'];
  profileId: string | null;
  conversationId: string | null;
  fingerprint: string | null;
}

/** Validates a target (strictly: no field of another kind) and checks it exists. `not-found` otherwise. */
function resolveNoteTarget(db: SqlDb, target: unknown): NoteKey {
  const t = requireRecord(target, 'target');
  const only = (...allowed: string[]) => {
    for (const key of Object.keys(t)) if (key !== 'kind' && !allowed.includes(key)) invalid(`a ${String(t.kind)} note has no ${key}`);
  };
  if (t.kind === 'profile') {
    only('profileId');
    return { kind: 'profile', profileId: requireProfile(db, t.profileId), conversationId: null, fingerprint: null };
  }
  if (t.kind === 'conversation') {
    only('conversationId');
    return { kind: 'conversation', profileId: null, conversationId: requireConversation(db, t.conversationId), fingerprint: null };
  }
  if (t.kind === 'message') {
    only('conversationId', 'messageId');
    const conversationId = requireUuid(t.conversationId, 'conversation id');
    if (typeof t.messageId !== 'number' || !Number.isSafeInteger(t.messageId) || t.messageId < 1) invalid('message id must be a positive integer');
    // The pair is checked: a message of another conversation is not-found, never revealed.
    const [row] = db.all<{ fingerprint: string }>('SELECT fingerprint FROM messages WHERE id = ? AND conversation_id = ?', [t.messageId, conversationId]);
    if (!row) notFound('message');
    return { kind: 'message', profileId: null, conversationId, fingerprint: row.fingerprint };
  }
  return invalid('note kind must be profile, conversation or message');
}

/** The WHERE of one note over `notes`, by kind (every branch hits a unique index). */
function noteWhere(key: NoteKey): { where: string; params: SqlValue[] } {
  if (key.kind === 'profile') return { where: 'profile_id = ?', params: [key.profileId] };
  if (key.kind === 'conversation') return { where: "kind = 'conversation' AND conversation_id = ?", params: [key.conversationId] };
  return { where: 'conversation_id = ? AND fingerprint = ?', params: [key.conversationId, key.fingerprint] };
}

const NOTE_COLUMNS = 'kind, body, created_at AS createdAt, updated_at AS updatedAt';

/** The note on a target, or `null` when there is none. `not-found` when the target does not exist. */
export function getNote(db: SqlDb, target: NoteTarget): Note | null {
  const { where, params } = noteWhere(resolveNoteTarget(db, target));
  return db.all<Note>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE ${where}`, params)[0] ?? null;
}

/**
 * Saves the note of a target: creates it, replaces its text (the first `created_at` stays,
 * `updated_at` moves only when the text really changes) or, when the trimmed text is empty,
 * deletes it (returns `null`). `invalid` for a text over the bound, `not-found` for an unknown
 * target (a message must belong to the conversation). Never logs the text.
 */
export function setNote(db: SqlDb, input: SetNoteInput): Note | null {
  requireRecord(input, 'params');
  const body = field(normalizeNote, input.body);
  requireString(input.now, 'now');
  return transaction(db, () => {
    const key = resolveNoteTarget(db, input.target);
    const { where, params } = noteWhere(key);
    if (body === '') {
      db.run(`DELETE FROM notes WHERE ${where}`, params);
      return null;
    }
    const [existing] = db.all<Note>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE ${where}`, params);
    if (!existing) {
      db.run('INSERT INTO notes (kind, profile_id, conversation_id, fingerprint, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        key.kind,
        key.profileId,
        key.conversationId,
        key.fingerprint,
        body,
        input.now,
        input.now,
      ]);
      return { kind: key.kind, body, createdAt: input.now, updatedAt: input.now };
    }
    if (existing.body === body) return existing;
    db.run(`UPDATE notes SET body = ?, updated_at = ? WHERE ${where}`, [body, input.now, ...params]);
    return { ...existing, body, updatedAt: input.now };
  });
}

export interface NoteScope {
  /** The person's own note plus the notes of the conversations linked to them (and their messages). */
  profileId?: string;
  /** The conversation's note plus the notes of its messages. At most one of the two; none = the whole archive. */
  conversationId?: string;
}

/** Validates the scope and returns its condition over `n` (notes) and its parameters. */
function noteScope(db: SqlDb, scope: NoteScope | undefined): { where: string; params: SqlValue[] } {
  const s = scope === undefined ? {} : requireRecord(scope, 'scope');
  if (s.profileId !== undefined && s.conversationId !== undefined) invalid('scope takes a profile or a conversation, not both');
  if (s.profileId !== undefined) {
    const id = requireProfile(db, s.profileId);
    return {
      where: 'AND (n.profile_id = ? OR n.conversation_id IN (SELECT conversation_id FROM conversation_profiles WHERE profile_id = ?))',
      params: [id, id],
    };
  }
  if (s.conversationId !== undefined) return { where: 'AND n.conversation_id = ?', params: [requireConversation(db, s.conversationId)] };
  return { where: '', params: [] };
}

/** A message note is visible only while its message is in the archive (otherwise it is dormant). */
const NOTE_VISIBLE = "(n.kind <> 'message' OR m.id IS NOT NULL)";
const NOTE_MESSAGE_JOIN = "LEFT JOIN messages m ON n.kind = 'message' AND m.conversation_id = n.conversation_id AND m.fingerprint = n.fingerprint";

/** How many notes are visible in the scope (dormant message notes are not counted). */
export function countNotes(db: SqlDb, scope?: NoteScope): number {
  const { where, params } = noteScope(db, scope);
  const [row] = db.all<{ n: number }>(`SELECT count(*) AS n FROM notes n ${NOTE_MESSAGE_JOIN} WHERE ${NOTE_VISIBLE} ${where}`, params);
  return row.n;
}

type NoteRow = Omit<NoteItem, 'message'> & {
  messageId: number | null;
  messageSentAt: string | null;
  messageType: NonNullable<NoteItem['message']>['type'] | null;
  messageAuthor: string | null;
  messageIsMe: number;
  messageBody: string | null;
  messageMediaName: string | null;
};

/**
 * `limit` notes from position `offset`, the most recently edited first (`updated_at` descending;
 * ties by creation then storage order, so pages never overlap), each with the names and, for a
 * message note, the message it is on. Limit clamped to 1..MAX_WINDOW; past the end is empty.
 */
export function listNotes(db: SqlDb, scope: NoteScope | undefined, offset: number, limit: number): NoteItem[] {
  const { where, params } = noteScope(db, scope);
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
  if (!Number.isFinite(limit)) invalid('limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_WINDOW);
  return db
    .all<NoteRow>(
      `SELECT n.kind, n.body, n.created_at AS createdAt, n.updated_at AS updatedAt,
              n.profile_id AS profileId, pr.display_name AS profileName,
              n.conversation_id AS conversationId, c.title AS conversationTitle,
              m.id AS messageId, m.sent_at AS messageSentAt, m.type AS messageType,
              p.display_name AS messageAuthor, COALESCE(p.is_me, 0) AS messageIsMe,
              m.body AS messageBody, m.media_name AS messageMediaName
         FROM notes n
         ${NOTE_MESSAGE_JOIN}
         LEFT JOIN profiles pr ON pr.id = n.profile_id
         LEFT JOIN conversations c ON c.id = n.conversation_id
         LEFT JOIN participants p ON p.id = m.participant_id
        WHERE ${NOTE_VISIBLE} ${where}
        ORDER BY n.updated_at DESC, n.created_at DESC, n.rowid DESC LIMIT ? OFFSET ?`,
      [...params, n, offset],
    )
    .map((r) => ({
      kind: r.kind,
      body: r.body,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      profileId: r.profileId,
      profileName: r.profileName,
      conversationId: r.conversationId,
      conversationTitle: r.conversationTitle,
      message:
        r.messageId === null
          ? null
          : {
              id: r.messageId,
              sentAt: r.messageSentAt!,
              type: r.messageType!,
              participantName: r.messageAuthor,
              isMe: r.messageIsMe === 1,
              body: r.messageBody!,
              mediaName: r.messageMediaName!,
            },
    }));
}

/** What the library stores, in bytes, as far as the database can tell (see `getStorageBreakdown`). */
export interface StorageBreakdown {
  /** Stored files referenced by at least one photo or video message. */
  photosVideosBytes: number;
  /** Every other stored file: audio, stickers, documents, profile photos. */
  otherMediaBytes: number;
  /** The database itself (messages, notes, search index): `page_count * page_size`. */
  databaseBytes: number;
}

/**
 * Bytes by kind. A file is "photos and videos" when any photo or video message points at it
 * (stored once even when shared by several messages, like the blob store does). The database
 * size is the SQLite page count times the page size, i.e. the logical size of the file.
 */
export function getStorageBreakdown(db: SqlDb): StorageBreakdown {
  const [media] = db.all<{ visual: number; other: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN visual THEN size ELSE 0 END), 0) AS visual,
       COALESCE(SUM(CASE WHEN visual THEN 0 ELSE size END), 0) AS other
     FROM (SELECT b.size AS size,
                  EXISTS (SELECT 1 FROM messages m WHERE m.media_sha256 = b.sha256 AND m.type IN ('photo', 'video')) AS visual
           FROM blobs b)`,
  );
  const [pages] = db.all<{ count: number }>('SELECT page_count * page_size AS count FROM pragma_page_count, pragma_page_size');
  return { photosVideosBytes: media.visual, otherMediaBytes: media.other, databaseBytes: pages.count };
}

/** Row counts and bytes the Backup screen shows (see `getLibraryStats`). */
export interface LibraryStats {
  profiles: number;
  conversations: number;
  messages: number;
  /** Rows in `blobs`: stored files, each counted once. */
  mediaFiles: number;
  /** Sum of the recorded sizes of those files. */
  mediaBytes: number;
  /** `page_count * page_size` of the library file. */
  databaseBytes: number;
}

export function getLibraryStats(db: SqlDb): LibraryStats {
  const one = (sql: string) => db.all<{ n: number }>(sql)[0].n;
  return {
    profiles: one('SELECT count(*) AS n FROM profiles'),
    conversations: one('SELECT count(*) AS n FROM conversations'),
    messages: one('SELECT count(*) AS n FROM messages'),
    mediaFiles: one('SELECT count(*) AS n FROM blobs'),
    mediaBytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'),
    databaseBytes: one('SELECT page_count * page_size AS n FROM pragma_page_count, pragma_page_size'),
  };
}

export const BLOB_PAGE_MAX = 5000;

/** Media rows in hash order, `limit` (1..5000) after the hash `after`: lets a long check walk them without holding the list. */
export function listBlobPage(db: SqlDb, after: string | undefined, limit: number): { sha256: string; size: number }[] {
  if (after !== undefined && typeof after !== 'string') throw new DbError('invalid', 'after must be a hash');
  if (!Number.isFinite(limit)) throw new DbError('invalid', 'limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 1), BLOB_PAGE_MAX);
  return db.all<{ sha256: string; size: number }>('SELECT sha256, size FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT ?', [after ?? '', n]);
}

/** A message or profile photo whose media hash has no `blobs` row (foreign keys should prevent it; this is the proof). */
export type DanglingReference =
  | { source: 'message'; id: number; sha256: string }
  | { source: 'profile-photo'; id: string; sha256: string };

/** Read-only: how many references dangle, and the first `limit` of them (messages first, by id). */
export function findDanglingBlobRefs(db: SqlDb, limit: number): { total: number; items: DanglingReference[] } {
  if (!Number.isFinite(limit)) throw new DbError('invalid', 'limit must be a number');
  const n = Math.min(Math.max(Math.trunc(limit), 0), BLOB_PAGE_MAX);
  const count = (sql: string) => db.all<{ n: number }>(sql)[0].n;
  const messages = `FROM messages m WHERE m.media_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = m.media_sha256)`;
  const photos = `FROM profiles p WHERE p.photo_sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = p.photo_sha256)`;
  const total = count(`SELECT count(*) AS n ${messages}`) + count(`SELECT count(*) AS n ${photos}`);
  const items: DanglingReference[] = db
    .all<{ id: number; sha256: string }>(`SELECT m.id AS id, m.media_sha256 AS sha256 ${messages} ORDER BY m.id LIMIT ?`, [n])
    .map((r) => ({ source: 'message', id: r.id, sha256: r.sha256 }));
  if (items.length < n) {
    for (const r of db.all<{ id: string; sha256: string }>(`SELECT p.id AS id, p.photo_sha256 AS sha256 ${photos} ORDER BY p.id LIMIT ?`, [n - items.length])) {
      items.push({ source: 'profile-photo', id: r.id, sha256: r.sha256 });
    }
  }
  return { total, items };
}
