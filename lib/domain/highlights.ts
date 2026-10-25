import { isSha256Hex, type MessageType } from './library';

/**
 * `findings.json` version 1: the file a person (or a tool they run outside the app) hands to
 * the archive to mark key moments, patterns and messages of interest in a conversation.
 * Messages are referenced by fingerprint, never by local id, so a file survives backup,
 * restore and merge (see `fingerprint.ts`).
 *
 * THIS IS A DATA FORMAT. Readers must accept every `version` that ever shipped and refuse
 * newer ones. The file is untrusted input: `parseFindings` bounds every size and count and
 * returns typed errors, it never throws on bad data.
 */
export const FINDINGS_VERSION = 1;

export const HIGHLIGHT_CATEGORIES = ['moment', 'pattern', 'interest'] as const;
export type HighlightCategory = (typeof HIGHLIGHT_CATEGORIES)[number];

/** Input bounds, in UTF-16 code units for text and in items for lists. */
export const FINDINGS_LIMITS = {
  conversationName: 200,
  highlights: 1000,
  messagesPerHighlight: 200,
  id: 100,
  title: 200,
  summary: 4000,
  createdBy: 100,
} as const;

export interface FindingsConversation {
  name: string;
  messageCount: number;
  /** Fingerprint of the first message the author saw; lets a reader sanity-check the match. */
  firstFingerprint?: string;
}

export interface Highlight {
  /** Stable id chosen by the author of the file (idempotent re-import keys on it). */
  id: string;
  category: HighlightCategory;
  title: string;
  summary: string;
  /** Message fingerprints (64 lowercase hex), in the order the author listed them. */
  messages: string[];
  createdBy: string;
  /** UTC instant, `YYYY-MM-DDTHH:MM:SS(.sss)Z`. */
  createdAt: string;
}

export interface Findings {
  version: typeof FINDINGS_VERSION;
  conversation: FindingsConversation;
  highlights: Highlight[];
}

export type FindingsErrorCode =
  | 'not-object'
  | 'unsupported-version'
  | 'invalid-conversation'
  | 'invalid-highlights'
  | 'too-many-highlights'
  | 'invalid-highlight'
  | 'duplicate-id'
  | 'invalid-category'
  | 'invalid-fingerprint'
  | 'too-many-messages'
  | 'too-long';

export interface FindingsError {
  code: FindingsErrorCode;
  /** JSON path of the offending value, e.g. `highlights[2].messages[0]`. */
  path: string;
  /** Never contains the offending value itself (it may be chat content). */
  message: string;
}

export type FindingsResult = { ok: true; value: Findings } | { ok: false; errors: FindingsError[] };

/** Stop collecting after this many errors: a hostile file must not make the report huge. */
const MAX_ERRORS = 20;

const ID_RE = /^[A-Za-z0-9._:-]+$/;
const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Bidi controls and C0/C1 controls (newlines are allowed only in the summary).
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/u;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE_RE.test(s);
}

function isUtcInstant(v: string): boolean {
  return UTC_INSTANT_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * Validate an already-parsed JSON value as `findings.json` v1. Unknown extra keys are
 * ignored (and dropped from the result). Text is returned trimmed.
 */
export function parseFindings(input: unknown): FindingsResult {
  const errors: FindingsError[] = [];
  const err = (code: FindingsErrorCode, path: string, message: string): void => {
    if (errors.length < MAX_ERRORS) errors.push({ code, path, message });
  };

  if (!isRecord(input)) {
    return { ok: false, errors: [{ code: 'not-object', path: '', message: 'The file must be a JSON object.' }] };
  }
  if (input.version !== FINDINGS_VERSION) {
    const newer = typeof input.version === 'number' && input.version > FINDINGS_VERSION;
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported-version',
          path: 'version',
          message: newer
            ? `Version ${input.version} is newer than this app understands (${FINDINGS_VERSION}).`
            : `Unsupported version; expected ${FINDINGS_VERSION}.`,
        },
      ],
    };
  }

  // Text field: string, trimmed, bounded, no control characters, no lone surrogates.
  const text = (v: unknown, path: string, max: number, opts: { multiline?: boolean; required?: boolean } = {}): string | null => {
    if (typeof v !== 'string') {
      err('invalid-highlight', path, 'Must be a string.');
      return null;
    }
    const t = v.trim();
    if (t.length > max) {
      err('too-long', path, `Longer than ${max} characters.`);
      return null;
    }
    if ((opts.required ?? true) && t === '') {
      err('invalid-highlight', path, 'Must not be empty.');
      return null;
    }
    if (hasLoneSurrogate(t) || CONTROL_RE.test(t) || (!opts.multiline && LINE_BREAK_RE.test(t))) {
      err('invalid-highlight', path, 'Contains characters that are not allowed.');
      return null;
    }
    return t;
  };

  let conversation: FindingsConversation | null = null;
  const c = input.conversation;
  if (!isRecord(c)) {
    err('invalid-conversation', 'conversation', 'Must be an object.');
  } else {
    const name = text(c.name, 'conversation.name', FINDINGS_LIMITS.conversationName);
    const countOk = typeof c.messageCount === 'number' && Number.isSafeInteger(c.messageCount) && c.messageCount >= 0;
    if (!countOk) err('invalid-conversation', 'conversation.messageCount', 'Must be a non-negative integer.');
    let first: string | undefined;
    if (c.firstFingerprint !== undefined) {
      if (isSha256Hex(c.firstFingerprint)) first = c.firstFingerprint;
      else err('invalid-fingerprint', 'conversation.firstFingerprint', 'Must be 64 lowercase hex characters.');
    }
    if (name !== null && countOk && (c.firstFingerprint === undefined || first !== undefined)) {
      conversation = { name, messageCount: c.messageCount as number, ...(first ? { firstFingerprint: first } : {}) };
    }
  }

  const highlights: Highlight[] = [];
  const raw = input.highlights;
  if (!Array.isArray(raw)) {
    err('invalid-highlights', 'highlights', 'Must be an array.');
  } else if (raw.length > FINDINGS_LIMITS.highlights) {
    err('too-many-highlights', 'highlights', `More than ${FINDINGS_LIMITS.highlights} highlights.`);
  } else {
    const ids = new Set<string>();
    raw.forEach((h: unknown, i) => {
      const at = `highlights[${i}]`;
      if (!isRecord(h)) {
        err('invalid-highlight', at, 'Must be an object.');
        return;
      }
      const before = errors.length;
      const id = text(h.id, `${at}.id`, FINDINGS_LIMITS.id);
      if (id !== null && !ID_RE.test(id)) err('invalid-highlight', `${at}.id`, 'Only letters, digits and . _ : - are allowed.');
      if (id !== null && ids.has(id)) err('duplicate-id', `${at}.id`, 'Duplicate highlight id.');
      else if (id !== null) ids.add(id);
      let category: HighlightCategory | null = null;
      if ((HIGHLIGHT_CATEGORIES as readonly unknown[]).includes(h.category)) category = h.category as HighlightCategory;
      else err('invalid-category', `${at}.category`, `Must be one of ${HIGHLIGHT_CATEGORIES.join(', ')}.`);
      const title = text(h.title, `${at}.title`, FINDINGS_LIMITS.title);
      const summary = text(h.summary, `${at}.summary`, FINDINGS_LIMITS.summary, { multiline: true, required: false });
      const createdBy = text(h.createdBy, `${at}.createdBy`, FINDINGS_LIMITS.createdBy);
      if (typeof h.createdAt !== 'string' || !isUtcInstant(h.createdAt)) {
        err('invalid-highlight', `${at}.createdAt`, 'Must be a UTC instant like 2026-01-31T10:00:00Z.');
      }
      const messages: string[] = [];
      if (!Array.isArray(h.messages) || h.messages.length === 0) {
        err('invalid-highlight', `${at}.messages`, 'Must be a non-empty array.');
      } else if (h.messages.length > FINDINGS_LIMITS.messagesPerHighlight) {
        err('too-many-messages', `${at}.messages`, `More than ${FINDINGS_LIMITS.messagesPerHighlight} messages.`);
      } else {
        h.messages.forEach((f: unknown, j) => {
          if (isSha256Hex(f)) messages.push(f);
          else err('invalid-fingerprint', `${at}.messages[${j}]`, 'Must be 64 lowercase hex characters.');
        });
      }
      if (errors.length === before && id !== null && category && title !== null && summary !== null && createdBy !== null) {
        highlights.push({ id, category, title, summary, messages, createdBy, createdAt: h.createdAt as string });
      }
    });
  }

  if (errors.length > 0 || !conversation) return { ok: false, errors };
  return { ok: true, value: { version: FINDINGS_VERSION, conversation, highlights } };
}

/** Largest `findings.json` text accepted (UTF-16 code units): above the biggest valid file. */
export const MAX_FINDINGS_TEXT = 32 * 1024 * 1024;

/** `JSON.parse` + `parseFindings` for the raw text of a file. Never throws; errors carry no file content. */
export function parseFindingsText(text: string): FindingsResult {
  if (typeof text !== 'string' || text.length > MAX_FINDINGS_TEXT) {
    return { ok: false, errors: [{ code: 'too-long', path: '', message: 'The file is too large.' }] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ code: 'not-object', path: '', message: 'The file is not valid JSON.' }] };
  }
  return parseFindings(json);
}

// ------------------------------------------------------------------ stored highlights

/** A stored highlight with what a list needs. Untrusted text: title, summary, author, conversation title. */
export interface HighlightItem {
  id: string;
  conversationId: string;
  conversationTitle: string;
  category: HighlightCategory;
  title: string;
  summary: string;
  createdBy: string;
  /** The instant the author wrote in the file. */
  createdAt: string;
  importedAt: string;
  /** How many of its messages are in the archive now. */
  messageCount: number;
  /** Local time of its earliest message in the archive; lists are ordered by it. */
  firstSentAt: string;
}

/** One message of a highlight, in the order the author listed them. `id` is the local id (to open it). */
export interface HighlightMessage {
  id: number;
  sentAt: string;
  type: MessageType;
  participantName: string | null;
  isMe: boolean;
  body: string;
  mediaName: string;
}

/** What an import did, counted per highlight. */
export interface HighlightImportCounts {
  imported: number;
  updated: number;
  unchanged: number;
  /** Highlights left out because none of their messages is in the conversation (ids, in file order). */
  skippedHighlights: string[];
  /** Fingerprints of the file (counted per highlight) that are not in the conversation. */
  skippedFingerprints: number;
}
