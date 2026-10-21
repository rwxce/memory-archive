import { isLocalTimestamp, type MessageType } from './library';
import { sha256Hex } from './sha256';

/**
 * Message fingerprints: the identity that makes imports idempotent. The same message in
 * two exports (an overlapping newer export, a re-export, another device's copy) must get
 * the same fingerprint; two genuinely different messages must not.
 *
 * THIS IS A DATA FORMAT. Every stored message carries its fingerprint, and a later import
 * only recognizes a message by recomputing the same value. Changing anything below (the
 * normalization, the field order, the encoding, the occurrence rule) silently turns every
 * message already in an archive into a "new" one on its next import. Treat any change as a
 * data migration: bump `FINGERPRINT_VERSION`, keep the old algorithm for old archives and
 * pin new test vectors. `fingerprint.test.ts` holds frozen vectors for exactly that reason.
 *
 * Algorithm (version 1): SHA-256 (lowercase hex) over the length-prefixed UTF-8 encoding of
 *   [ version, minute, author, type, text, mediaName, occurrence ]
 * where every field is encoded as a 4-byte big-endian byte length followed by its bytes
 * (the version and the occurrence index as decimal text). Length prefixes make the encoding
 * unambiguous: no choice of field contents can shift a boundary.
 *
 * - minute: the local wall-clock time as parsed, cut to the minute (`YYYY-MM-DDTHH:MM`).
 *   Android exports have minute resolution and iOS exports have seconds; the minute is the
 *   common denominator, so the two formats of one chat agree. No timezone is invented.
 * - author: see `normalizeAuthor`. System messages have no author: ''.
 * - type: the message type as classified by the importer.
 * - text: see `normalizeText` (the caption for media messages).
 * - mediaName: the attachment's file name (see `normalizeMediaFileName`), or ''. It is the
 *   NAME, never the bytes' hash: a message keeps its identity whether or not its bytes were
 *   imported, as long as the transcript still names the file (`skipVideos`, a file missing from
 *   the ZIP). The bytes are referenced by the message row separately (content-addressed by their
 *   own SHA-256). An export made WITHOUT media is different: WhatsApp then replaces the
 *   attachment line with an "omitted" marker, which is a different message (type `omitted`, no
 *   name), so importing it after a media export adds new `omitted` rows. That is the actual
 *   behaviour and is pinned by tests; it is not an identity.
 * - occurrence: how many messages with the identical key (the six fields above) came
 *   before it in the same export, starting at 0. WhatsApp times have minute resolution, so
 *   "ok" sent twice in one minute by one person are two messages; the second gets index 1.
 *
 * Known limits (by design, documented for the user-facing history):
 * - Edited messages are new messages: WhatsApp exports the edited text only.
 * - The occurrence index counts within ONE export. If one of several identical messages (same
 *   key) is deleted between two exports, the later ones shift down by one, so a genuinely new
 *   identical message sent in that minute can take the index of one already stored and be
 *   skipped as a duplicate. Only messages with an identical repeated key are affected;
 *   everything else is untouched.
 * - An export that begins in the middle of a minute holding identical repeated messages
 *   starts their indexes at 0 again: the same shift, at the same single place.
 * - The minute is the phone's wall-clock text, not an instant. The same message exported from a
 *   device in another time zone, or after a daylight-saving or clock change, reads as a different
 *   minute and imports as a new message.
 * - The author is the name the exporting phone shows. A contact that was a phone number in one
 *   export and a saved name in the next (or was renamed) is a different author, so every message
 *   of that contact imports again as new.
 * - Two different chats are never compared by fingerprint alone: the database enforces
 *   uniqueness per conversation (`UNIQUE (conversation_id, fingerprint)`).
 */
export const FINGERPRINT_VERSION = 1;

/**
 * Format and bidirectional marks that vary between exports (a phone number wrapped in LRM /
 * isolates by one export and not by another): U+200B ZWSP, U+200E/F LRM/RLM, U+061C ALM,
 * U+202A-E embeddings and overrides, U+2066-9 isolates, U+FEFF BOM. ZWJ and ZWNJ are kept
 * on purpose: they change how emoji and several scripts are shaped, so they are content.
 * Display keeps the original text; only the fingerprint input drops these.
 */
const MARKS_RE = /[\u200B\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
/** No-break and narrow no-break spaces become a plain space (exports differ in which they use). */
const SPACES_RE = /[\u00A0\u2007\u202F]/gu;

function clean(value: string): string {
  return value.normalize('NFC').replace(MARKS_RE, '').replace(SPACES_RE, ' ');
}

/**
 * The author as one identity across exports: Unicode NFC, marks dropped, spaces collapsed
 * and trimmed, and a leading `~` (WhatsApp's "not in your contacts" prefix, present in some
 * exports and not in others) removed. Case is kept: "ana" and "Ana" are different names.
 */
export function normalizeAuthor(author: string): string {
  return clean(author).replace(/\s+/gu, ' ').trim().replace(/^~\s*/u, '');
}

/**
 * The message text: Unicode NFC, marks dropped, `\r\n` and `\r` become `\n`, trailing
 * whitespace removed from every line and leading/trailing blank space from the whole text.
 * Inner spacing is kept.
 */
export function normalizeText(text: string): string {
  return clean(text)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .trim();
}

/** The attachment's last path segment, NFC, marks dropped, trimmed. Case is kept. */
export function normalizeMediaFileName(name: string): string {
  return clean(name.slice(name.lastIndexOf('/') + 1)).trim();
}

export interface FingerprintInput {
  /** Local wall-clock time `YYYY-MM-DDTHH:MM:SS` (seconds are ignored). */
  sentAt: string;
  /** Raw author as named by the source; '' for system messages. */
  author: string;
  type: MessageType;
  text: string;
  /** Raw attachment name, or ''. */
  mediaName: string;
}

const encoder = new TextEncoder();

/** Length-prefixed concatenation: unambiguous whatever the fields contain. */
function encode(fields: readonly string[]): Uint8Array {
  const parts = fields.map((f) => encoder.encode(f));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/** The six content fields, normalized; `fingerprint` adds the version and the occurrence. */
function keyFields(m: FingerprintInput): string[] {
  if (!isLocalTimestamp(m.sentAt)) throw new RangeError('sentAt must be YYYY-MM-DDTHH:MM:SS');
  return [m.sentAt.slice(0, 16), normalizeAuthor(m.author), m.type, normalizeText(m.text), normalizeMediaFileName(m.mediaName)];
}

/**
 * The fingerprint of a message given how many identical ones came before it in the export.
 * Prefer `createFingerprinter`, which counts for you; this is the pure building block.
 */
export function fingerprintOf(m: FingerprintInput, occurrence: number): string {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) throw new RangeError('occurrence must be a non-negative integer');
  return sha256Hex(encode([String(FINGERPRINT_VERSION), ...keyFields(m), String(occurrence)]));
}

/**
 * One export's fingerprinter: call it for every message in transcript order. Identical
 * messages (same normalized key) get occurrence 0, 1, 2, ... in the order they are seen,
 * so same-minute repeats stay distinct while the whole sequence stays reproducible.
 */
export function createFingerprinter(): (m: FingerprintInput) => string {
  const seen = new Map<string, number>();
  return (m) => {
    const key = JSON.stringify(keyFields(m));
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return fingerprintOf(m, occurrence);
  };
}
