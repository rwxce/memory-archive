import type {
  PackBatchHeader,
  PackBlob,
  PackConversation,
  PackFavorite,
  PackMessage,
  PackNote,
  PackProfile,
  PackTombstone,
} from './changes-pack';

/**
 * What this device knows about another device it syncs with by hand (`docs/formats/changes-pack.md`).
 * Watermarks are change numbers (`seq`): 0 means nothing yet. They are per direction and per peer.
 */
export interface SyncPeer {
  peerId: string;
  /** Highest of OUR change numbers put in a changes pack for this peer (confirmed by its `ack` once it answers). */
  lastSentSeq: number;
  /** UTC instant of that pack; null before the first one. */
  lastSentAt: string | null;
  /** Highest of THEIR change numbers merged here. */
  lastReceivedSeq: number;
  lastReceivedAt: string | null;
}

export interface RecordSentInput {
  peerId: string;
  /** The pack's `upTo`: at most this device's current change counter. */
  upToSeq: number;
  /**
   * The pack's `since`, for a pack that carried only changes: the watermark is moved only if it
   * still equals this, so a pack confirmed late cannot undo what a newer ack or pack decided.
   * `null`/absent (a full pack) moves it forward unconditionally.
   */
  sinceSeq?: number | null;
  /** UTC instant (ISO 8601). */
  now: string;
}

export interface RecordSentResult {
  /** `false` when the watermark was no longer at the pack's `since` and was left alone. */
  recorded: boolean;
  peer: SyncPeer;
}

export interface RecordReceivedInput {
  peerId: string;
  /** The pack's `upTo`: the peer's counter when it read the records, now fully merged here. */
  upToSeq: number;
  /** The pack's `ack`: the highest of OUR change numbers the peer has merged; null when it never received from us. */
  ackedSeq: number | null;
  now: string;
}

// ------------------------------------------------------------------- merging a changes pack

/** Why a pack is refused before anything is merged (`docs/formats/changes-pack.md`, "Watermarks"). */
export type MergeRefusal =
  /** It was cut for another device. */
  | 'wrong-device'
  /** This device made it. */
  | 'own-pack'
  /** A pack between was never merged: `since` is above what was received from the source. */
  | 'gap';

/** What the manifest says about a pack, as far as accepting it goes. */
export interface PackAddress {
  kind: 'changes' | 'full';
  sourceDeviceId: string;
  targetDeviceId: string | null;
  since: number;
  upTo: number;
  ack: number | null;
}

/** A pack's records, validated, in one request: the merge is ONE transaction in the database worker. */
export interface MergeChangesPackInput extends PackAddress {
  /** UTC instant (ISO 8601) the merge runs at. */
  now: string;
  blobs: PackBlob[];
  profiles: PackProfile[];
  conversations: PackConversation[];
  batches: { header: PackBatchHeader; messages: PackMessage[] }[];
  favorites: PackFavorite[];
  notes: PackNote[];
  tombstones: PackTombstone[];
}

export interface MergeCounts {
  blobs: number;
  profiles: { added: number; updated: number };
  conversations: { added: number; updated: number };
  batches: number;
  messages: { added: number; skipped: number };
  favorites: { added: number; removed: number };
  notes: { added: number; updated: number; removed: number };
}

export type MergeChangesPackResult =
  | { refused: MergeRefusal }
  | {
      refused: null;
      counts: MergeCounts;
      /** Crossed edits kept beside the active record (see `SyncConflict`). */
      conflicts: number;
      /** Undone imports offered for review (nothing was removed). */
      batchOffers: number;
      /**
       * Media rows this merge added that nothing refers to (a batch that was skipped): the rows are
       * gone, the caller deletes the bytes.
       */
      unreferencedBlobs: string[];
      peer: SyncPeer;
    };

export type ConflictKind = 'profile' | 'conversation' | 'note' | 'batch';

/** The version of a profile or conversation that is active on this device, in the pack's own shape (without `seq`). */
export type LocalProfileVersion = Omit<PackProfile, 'seq'>;
export type LocalConversationVersion = Omit<PackConversation, 'seq'>;
export type LocalNoteVersion = Omit<PackNote, 'seq'>;

/**
 * A crossed edit, or an offered deletion, waiting for the user. The active record on this device is
 * `local` and has not been touched; `incoming` is what `peerId` sent. `kind: 'batch'` is not a
 * conflict but the offer to remove an import the peer undid (`incoming` is its tombstone;
 * `matched` says whether this device has a batch with that id).
 */
export interface SyncConflict {
  id: number;
  peerId: string;
  kind: ConflictKind;
  scope: string;
  key: string;
  /** The peer's version; its tombstone when it deleted the record (`incomingDeleted`). */
  incoming: PackProfile | PackConversation | PackNote | PackTombstone;
  incomingDeleted: boolean;
  detectedAt: string;
  /** The active version here; `null` when there is none (a note deleted here, edited there; a batch that is not here). */
  local: LocalProfileVersion | LocalConversationVersion | LocalNoteVersion | null;
  matched?: boolean;
}

export type ConflictChoice = 'mine' | 'theirs' | 'both';

/** Which version of a conflict a person looked at: an `id` can be reused, and a newer incoming version replaces the row in place. */
export interface ExpectedConflict {
  key: string;
  detectedAt: string;
}

export interface ResolveConflictInput {
  id: number;
  choice: ConflictChoice;
  now: string;
  /** When given and the open row is not this one (another record took the id, or a newer version replaced it), nothing changes: `not-found`. */
  expected?: ExpectedConflict;
}
