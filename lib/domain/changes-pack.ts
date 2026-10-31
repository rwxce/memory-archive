/**
 * The records of a changes pack (`docs/formats/changes-pack.md`, "Records"): plain, serializable
 * data keyed by the library's stable ids (UUIDs, fingerprints, SHA-256 hashes), never local row
 * ids. `seq` is the SOURCE device's number for the record's last change. Key order here is the
 * order the exporter writes, so equal data gives equal bytes.
 */

/** `format` field of a changes pack manifest (the backup's is `memory-archive`). */
export const CHANGES_PACK_FORMAT_NAME = 'memory-archive-changes';

/**
 * Version of the changes-pack format: manifest, entry layout and record shapes. Bumped only when an
 * older reader could misread a newer pack; readers accept every version they ever shipped.
 */
export const CHANGES_PACK_FORMAT_VERSION = 1;

export interface PackProfile {
  id: string;
  displayName: string;
  relationship: string;
  description: string;
  photoSha256: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PackParticipant {
  displayName: string;
  profileId: string | null;
  isMe: boolean;
}

export interface PackConversation {
  id: string;
  title: string;
  source: string;
  sourceKey: string;
  isGroup: boolean;
  createdAt: string;
  seq: number;
  profileIds: string[];
  /** Only participants linked to a profile or marked as "me". */
  participants: PackParticipant[];
}

export interface PackBlob {
  sha256: string;
  size: number;
  mime: string | null;
}

export interface PackFavorite {
  conversationId: string;
  fingerprint: string;
  createdAt: string;
  seq: number;
}

export type PackNoteTarget =
  | { kind: 'profile'; profileId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'message'; conversationId: string; fingerprint: string };

export interface PackNote {
  target: PackNoteTarget;
  body: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PackTombstone {
  kind: 'favorite' | 'note' | 'batch';
  scope: string;
  key: string;
  deletedAt: string;
  seq: number;
}

/** First line of a `batches/<id>.jsonl` entry; the lines after it are the batch's messages. */
export interface PackBatchHeader {
  id: string;
  conversationId: string;
  source: string;
  sourceLabel: string;
  createdAt: string;
  createdConversation: boolean;
  seq: number;
}

export interface PackMessage {
  fingerprint: string;
  sentAt: string;
  ordinal: number;
  type: string;
  /** The display name as the source named it. */
  author: string | null;
  body: string;
  mediaSha256: string | null;
  mediaName: string;
}

/**
 * Everything a pack needs from the database except message bodies, read in ONE synchronous step
 * together with `upTo` (`lib/db/changes.ts`). Messages are paged afterwards (`PackMessage`), under
 * the archive guard that keeps imports and undos out.
 */
export interface ChangeSet {
  schemaVersion: number;
  kind: 'changes' | 'full';
  sourceDeviceId: string;
  /** `null` for a `full` pack. */
  targetDeviceId: string | null;
  /** Exclusive lower bound of `seq`; 0 for `full`. */
  since: number;
  /** The source's change counter, read in the same step as the records. */
  upTo: number;
  /** What the source has merged from the target; `null` when it never received from it. */
  ack: number | null;
  profiles: PackProfile[];
  conversations: PackConversation[];
  blobs: PackBlob[];
  favorites: PackFavorite[];
  notes: PackNote[];
  tombstones: PackTombstone[];
  batches: PackBatchHeader[];
}

export interface ReadChangeSetInput {
  /** The device this pack is for; `null` = a pack for a device not known yet (always `full`). */
  peerId: string | null;
  /** Send everything even to a known peer (the remedy for a `gap`). */
  full?: boolean;
}

export interface ReadBatchMessagesInput {
  batchId: string;
  /** Local row id after which to continue (0 to start). */
  after: number;
  limit: number;
}

export interface BatchMessagesPage {
  messages: PackMessage[];
  /** Pass as `after` for the next page; unchanged when the page is empty. */
  last: number;
}
