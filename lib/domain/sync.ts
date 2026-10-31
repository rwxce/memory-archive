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
