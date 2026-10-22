/**
 * Input rules for profile, conversation and note details. Pure: shared by the use
 * cases (early, friendly checks) and `lib/db/queries.ts` (the boundary that
 * also receives requests from outside the type system).
 *
 * Text is trimmed, never silently truncated: a value over its bound is
 * rejected. Lengths are UTF-16 code units, the same unit as `String.length`.
 */

export const PROFILE_NAME_MAX = 100;
export const PROFILE_RELATIONSHIP_MAX = 60;
export const PROFILE_DESCRIPTION_MAX = 2000;
export const CONVERSATION_TITLE_MAX = 200;
/** A note on a person, conversation or message. */
export const NOTE_MAX = 10_000;

const CONTROL = /\p{Cc}/u;
/** Control characters a multi-line text may keep: tab, line feed, carriage return. */
const CONTROL_ALLOWED_IN_TEXT = /[\t\n\r]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/;
/**
 * Bidirectional embeddings and overrides (U+202A-202E) and isolates (U+2066-2069). Stripped from
 * single-line fields: they are invisible, can reorder surrounding text, and WhatsApp itself wraps
 * unsaved-number authors in them. The visible text keeps its logical order.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
/** A UTF-16 surrogate that is not part of a valid pair (matches only with the `u` flag). */
const LONE_SURROGATE = /\p{Cs}/u;
/** Blank-looking letters and symbols: Braille blank, Hangul fillers, combining grapheme joiner. */
const BLANK_LOOKALIKES = /[\u2800\u3164\u115f\u1160\uffa0\u034f]/g;

export class FieldError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'FieldError';
    this.field = field;
  }
}

function text(value: unknown, field: string, max: number, options: { required: boolean; multiline: boolean }): string {
  if (typeof value !== 'string') throw new FieldError(field, `${field} must be a string`);
  const trimmed = (options.multiline ? value : value.replace(BIDI_CONTROLS, '')).trim();
  if (trimmed.length > max) throw new FieldError(field, `${field} must be at most ${max} characters`);
  if (LONE_SURROGATE.test(trimmed)) throw new FieldError(field, `${field} is not valid Unicode text`);
  const controls = options.multiline ? trimmed.replace(CONTROL_ALLOWED_IN_TEXT, '') : trimmed;
  if (CONTROL.test(controls)) throw new FieldError(field, `${field} contains control characters`);
  if (!options.multiline && LINE_SEPARATORS.test(trimmed)) throw new FieldError(field, `${field} must be a single line`);
  if (options.required) {
    // At least one character a person can see: not a format character (zero-width, marks), separator or control.
    const visible = trimmed.replace(BLANK_LOOKALIKES, '').replace(/[\p{Cf}\p{Z}\p{Cc}]/gu, '');
    if (visible.length === 0) throw new FieldError(field, `${field} must not be empty`);
  }
  return trimmed;
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/** A plain `type/subtype` media type (no parameters), at most 255 characters. */
export function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && MIME_TYPE.test(value);
}

export const normalizeProfileName = (value: unknown) =>
  text(value, 'displayName', PROFILE_NAME_MAX, { required: true, multiline: false });

/** Empty means "not set". */
export const normalizeRelationship = (value: unknown) =>
  text(value, 'relationship', PROFILE_RELATIONSHIP_MAX, { required: false, multiline: false });

/** Empty means "not set". Line breaks are allowed. */
export const normalizeDescription = (value: unknown) =>
  text(value, 'description', PROFILE_DESCRIPTION_MAX, { required: false, multiline: true });

export const normalizeConversationTitle = (value: unknown) =>
  text(value, 'title', CONVERSATION_TITLE_MAX, { required: true, multiline: false });

/** The text of a note; line breaks allowed. Empty means "no note": saving it deletes the note. */
export const normalizeNote = (value: unknown) => text(value, 'note', NOTE_MAX, { required: false, multiline: true });
