import type {
  PackBatchHeader,
  PackBlob,
  PackConversation,
  PackFavorite,
  PackMessage,
  PackNote,
  PackNoteTarget,
  PackParticipant,
  PackProfile,
  PackTombstone,
} from './changes-pack';
import { isLocalTimestamp, isMessageType, isSha256Hex, isUuid } from './library';
import {
  FieldError,
  isMimeType,
  normalizeDescription,
  normalizeNote,
  normalizeProfileName,
  normalizeRelationship,
} from './profile';

/**
 * Strict validation of the records of a changes pack (`docs/formats/changes-pack.md`, "Records").
 * A pack comes from another device or from anyone who hands the user a file, so every field is
 * checked for type, shape and size before anything is merged. Pure: used by the use case (to refuse
 * a pack before a media file is written) and again by the database layer (which also receives
 * requests from outside the type system). Unknown extra keys are ignored: adding an optional field
 * does not change the format version. Messages never contain the offending value.
 */

export class PackRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackRecordError';
  }
}

const bad = (what: string): never => {
  throw new PackRecordError(`invalid changes pack record: ${what}`);
};

type Raw = Record<string, unknown>;

function record(value: unknown, what: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(`${what} is not an object`);
  return value as Raw;
}

function uuid(value: unknown, what: string): string {
  if (!isUuid(value)) bad(`${what} is not a lowercase UUID`);
  return value as string;
}

function sha(value: unknown, what: string): string {
  if (!isSha256Hex(value)) bad(`${what} is not a SHA-256 in lowercase hex`);
  return value as string;
}

function str(value: unknown, what: string, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.length < min) bad(`${what} is not a text of ${min}..${max} characters`);
  return value as string;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') bad(`${what} is not a boolean`);
  return value as boolean;
}

/** A change number: the source's counter value. */
function seq(value: unknown, what: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) bad(`${what} is not a change number`);
  return value as number;
}

/** A UTC instant (display only: no merge decision reads it). */
function instant(value: unknown, what: string): string {
  const text = str(value, what, 40, 1);
  if (Number.isNaN(Date.parse(text))) bad(`${what} is not a date`);
  return text;
}

/** A field of a profile or note: the same rules the app applies when a person types it, and already normalized. */
function normalized(normalize: (value: unknown) => string, value: unknown, what: string): string {
  let out: string;
  try {
    out = normalize(value);
  } catch (error) {
    if (error instanceof FieldError) return bad(`${what} breaks its rules`);
    throw error;
  }
  if (out !== value) bad(`${what} is not normalized`);
  return out;
}

export const MAX_TITLE = 20_000;
export const MAX_SOURCE_KEY = 2000;
export const MAX_LABEL = 4096;
export const MAX_NAME = 1000;
export const MAX_PARTICIPANTS = 100_000;
export const MAX_PROFILE_LINKS = 100_000;

export function parsePackProfile(raw: unknown): PackProfile {
  const r = record(raw, 'profile');
  const photo = r.photoSha256 === null ? null : sha(r.photoSha256, 'profile photo');
  const archivedAt = r.archivedAt === null ? null : instant(r.archivedAt, 'profile archivedAt');
  return {
    id: uuid(r.id, 'profile id'),
    displayName: normalized(normalizeProfileName, r.displayName, 'profile name'),
    relationship: normalized(normalizeRelationship, r.relationship, 'profile relationship'),
    description: normalized(normalizeDescription, r.description, 'profile description'),
    photoSha256: photo,
    archivedAt,
    createdAt: instant(r.createdAt, 'profile createdAt'),
    updatedAt: instant(r.updatedAt, 'profile updatedAt'),
    seq: seq(r.seq, 'profile seq'),
  };
}

function parseParticipant(raw: unknown): PackParticipant {
  const r = record(raw, 'participant');
  return {
    displayName: str(r.displayName, 'participant name', MAX_NAME),
    profileId: r.profileId === null ? null : uuid(r.profileId, 'participant profile id'),
    isMe: bool(r.isMe, 'participant isMe'),
  };
}

export function parsePackConversation(raw: unknown): PackConversation {
  const r = record(raw, 'conversation');
  if (!Array.isArray(r.profileIds) || r.profileIds.length > MAX_PROFILE_LINKS) bad('conversation profileIds is not a list');
  if (!Array.isArray(r.participants) || r.participants.length > MAX_PARTICIPANTS) bad('conversation participants is not a list');
  const profileIds = (r.profileIds as unknown[]).map((id) => uuid(id, 'conversation profile id'));
  if (new Set(profileIds).size !== profileIds.length) bad('conversation links a profile twice');
  const participants = (r.participants as unknown[]).map(parseParticipant);
  if (new Set(participants.map((p) => p.displayName)).size !== participants.length) bad('conversation names a participant twice');
  if (participants.filter((p) => p.isMe).length > 1) bad('conversation has more than one "me"');
  return {
    id: uuid(r.id, 'conversation id'),
    title: str(r.title, 'conversation title', MAX_TITLE),
    source: str(r.source, 'conversation source', 100, 1),
    sourceKey: str(r.sourceKey, 'conversation sourceKey', MAX_SOURCE_KEY),
    isGroup: bool(r.isGroup, 'conversation isGroup'),
    createdAt: instant(r.createdAt, 'conversation createdAt'),
    seq: seq(r.seq, 'conversation seq'),
    profileIds,
    participants,
  };
}

export function parsePackBlob(raw: unknown): PackBlob {
  const r = record(raw, 'blob');
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) bad('blob size');
  if (r.mime !== null && !isMimeType(r.mime)) bad('blob mime');
  return { sha256: sha(r.sha256, 'blob hash'), size: r.size as number, mime: r.mime as string | null };
}

export function parsePackFavorite(raw: unknown): PackFavorite {
  const r = record(raw, 'favorite');
  return {
    conversationId: uuid(r.conversationId, 'favorite conversation id'),
    fingerprint: sha(r.fingerprint, 'favorite fingerprint'),
    createdAt: instant(r.createdAt, 'favorite createdAt'),
    seq: seq(r.seq, 'favorite seq'),
  };
}

function parseNoteTarget(raw: unknown): PackNoteTarget {
  const t = record(raw, 'note target');
  if (t.kind === 'profile') return { kind: 'profile', profileId: uuid(t.profileId, 'note profile id') };
  if (t.kind === 'conversation') return { kind: 'conversation', conversationId: uuid(t.conversationId, 'note conversation id') };
  if (t.kind === 'message') {
    return { kind: 'message', conversationId: uuid(t.conversationId, 'note conversation id'), fingerprint: sha(t.fingerprint, 'note fingerprint') };
  }
  return bad('note target kind');
}

export function parsePackNote(raw: unknown): PackNote {
  const r = record(raw, 'note');
  const body = normalized(normalizeNote, r.body, 'note body');
  if (body === '') bad('a note is never empty');
  return {
    target: parseNoteTarget(r.target),
    body,
    createdAt: instant(r.createdAt, 'note createdAt'),
    updatedAt: instant(r.updatedAt, 'note updatedAt'),
    seq: seq(r.seq, 'note seq'),
  };
}

/** How a note, and its tombstone, is named: `scope` is the conversation id ('' for a person's note), `key` the target. */
export function noteTombstoneKey(target: PackNoteTarget): { scope: string; key: string } {
  if (target.kind === 'profile') return { scope: '', key: `profile:${target.profileId}` };
  if (target.kind === 'conversation') return { scope: target.conversationId, key: 'conversation' };
  return { scope: target.conversationId, key: `message:${target.fingerprint}` };
}

/** The tombstone `scope` / `key` of a note must be exactly the shape the schema writes. */
function checkNoteKey(scope: string, key: string): void {
  if (scope === '') {
    if (!key.startsWith('profile:') || !isUuid(key.slice(8))) bad('note tombstone key');
    return;
  }
  if (!isUuid(scope)) bad('note tombstone scope');
  if (key === 'conversation') return;
  if (!key.startsWith('message:') || !isSha256Hex(key.slice(8))) bad('note tombstone key');
}

export function parsePackTombstone(raw: unknown): PackTombstone {
  const r = record(raw, 'tombstone');
  if (r.kind !== 'favorite' && r.kind !== 'note' && r.kind !== 'batch') bad('tombstone kind');
  const kind = r.kind as PackTombstone['kind'];
  const scope = str(r.scope, 'tombstone scope', 36);
  const key = str(r.key, 'tombstone key', 80, 1);
  if (kind === 'note') checkNoteKey(scope, key);
  else {
    uuid(scope, 'tombstone scope');
    if (kind === 'favorite') sha(key, 'tombstone key');
    else uuid(key, 'tombstone key');
  }
  return { kind, scope, key, deletedAt: instant(r.deletedAt, 'tombstone deletedAt'), seq: seq(r.seq, 'tombstone seq', 1) };
}

export function parsePackBatchHeader(raw: unknown): PackBatchHeader {
  const r = record(raw, 'batch');
  return {
    id: uuid(r.id, 'batch id'),
    conversationId: uuid(r.conversationId, 'batch conversation id'),
    source: str(r.source, 'batch source', 100, 1),
    sourceLabel: str(r.sourceLabel, 'batch label', MAX_LABEL),
    createdAt: instant(r.createdAt, 'batch createdAt'),
    createdConversation: bool(r.createdConversation, 'batch createdConversation'),
    seq: seq(r.seq, 'batch seq'),
  };
}

export function parsePackMessage(raw: unknown): PackMessage {
  const r = record(raw, 'message');
  if (!isLocalTimestamp(r.sentAt)) bad('message sentAt');
  if (!isMessageType(r.type)) bad('message type');
  if (typeof r.ordinal !== 'number' || !Number.isSafeInteger(r.ordinal) || r.ordinal < 0) bad('message ordinal');
  if (typeof r.body !== 'string') bad('message body');
  return {
    fingerprint: sha(r.fingerprint, 'message fingerprint'),
    sentAt: r.sentAt as string,
    ordinal: r.ordinal as number,
    type: r.type as string,
    author: r.author === null ? null : str(r.author, 'message author', MAX_NAME),
    body: r.body as string,
    mediaSha256: r.mediaSha256 === null ? null : sha(r.mediaSha256, 'message media hash'),
    mediaName: str(r.mediaName, 'message mediaName', MAX_NAME),
  };
}
