/**
 * Domain model of the photo collection: pictures and videos the person chose to bring in from
 * a source that is not a chat (today a Google Photos Takeout album). Pure types and invariants,
 * no I/O. Format: `docs/formats/photo-library.md`.
 *
 * Rules:
 * - an item belongs to the library, NOT to a profile: nothing is ever assigned by date;
 * - the bytes are a content-addressed blob (`sha256`); the same bytes in two albums are two
 *   items over one blob;
 * - `takenAt` is what the source recorded for when the picture was taken (a UTC instant), kept
 *   as is; it is `null` when unknown and is never replaced by the import date.
 */

export const PHOTO_KINDS = ['photo', 'video'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const isPhotoKind = (value: unknown): value is PhotoKind => value === 'photo' || value === 'video';

/** The label of items imported from a Google Photos Takeout. A free label, so another source needs no schema change. */
export const PHOTO_SOURCE_TAKEOUT = 'takeout';

export const PHOTO_DESCRIPTION_MAX = 4000;
export const PHOTO_ALBUM_MAX = 200;
export const PHOTO_FILE_NAME_MAX = 255;

/**
 * Text limits above count Unicode code points (an emoji is 1, whatever its UTF-16 length), so the
 * importer that truncates and the database that checks agree, and a cut never splits a pair.
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 0xd800 && value.charCodeAt(i) <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** The first `max` code points of `value`; never cuts a surrogate pair in two. */
export function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  let i = 0;
  for (let n = 0; n < max && i < value.length; n++) {
    const unit = value.charCodeAt(i);
    const next = value.charCodeAt(i + 1);
    i += unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
  }
  return value.slice(0, i);
}

const TAKEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** `2019-07-01T10:00:00Z`: a UTC instant at second resolution that is a real calendar date and time. */
export function isTakenAt(value: unknown): value is string {
  if (typeof value !== 'string' || !TAKEN_AT_RE.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** What an importer hands over for one picture; its bytes are already in the blob store. */
export interface NewPhotoItem {
  sha256: string;
  kind: PhotoKind;
  mime: string | null;
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string;
  /** Album name as the source calls it; '' for a picture that is in no album. */
  album: string;
  /** The file name inside the source, without folders. Untrusted text, only ever displayed. */
  fileName: string;
}

export interface PhotoItem extends NewPhotoItem {
  id: number;
  source: string;
  batchId: string;
}

/** One import that added photos. */
export interface PhotoBatch {
  id: string;
  source: string;
  sourceLabel: string;
  createdAt: string;
  addedCount: number;
  skippedCount: number;
}
