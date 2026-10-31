/**
 * Domain model of the photo collection: pictures and videos the person chose to bring in from
 * a source that is not a chat (today a Google Photos Takeout album). Pure types and invariants,
 * no I/O. Format: `docs/formats/photo-library.md`.
 *
 * Show a date only through `photoDisplayDate`. Rules:
 * - an item belongs to the library, NOT to a profile: nothing is ever assigned by date;
 * - the bytes are a content-addressed blob (`sha256`); the same bytes in two albums are two
 *   items over one blob;
 * - `takenAt` is what the source recorded for when the picture was taken (a UTC instant), kept
 *   as is; it is `null` when unknown and is never replaced by the import date. `dateSource` says
 *   whether it is original or a guess.
 */

export const PHOTO_KINDS = ['photo', 'video'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const isPhotoKind = (value: unknown): value is PhotoKind => value === 'photo' || value === 'video';

/** The label of items imported from a Google Photos Takeout. A free label, so another source needs no schema change. */
export const PHOTO_SOURCE_TAKEOUT = 'takeout';
/** Pictures and videos chosen one by one from the device (file picker, gallery). */
export const PHOTO_SOURCE_LOOSE = 'loose';
/** A flat ZIP downloaded from photos.google.com (a selection), without Takeout's folders and sidecars. */
export const PHOTO_SOURCE_GOOGLE_PHOTOS_ZIP = 'google-photos-zip';

/**
 * Where `takenAt` came from, so a screen can tell an original date from a guess:
 * - `sidecar`: the Google Photos metadata JSON (a real instant, epoch seconds);
 * - `exif`: the camera's DateTimeOriginal with its UTC offset (a real instant; the offset is kept in
 *   `takenOffsetMinutes` so the local day is not lost);
 * - `exif-local`: DateTimeOriginal without an offset: the camera's wall-clock digits, stored as if
 *   they were UTC. Show the digits as written, never converted to the viewer's zone;
 * - `file-modified`: the file's last-modified time. A GUESS (it is the day the file was saved or
 *   copied as often as the day it was taken): never present it as the original date;
 * - `none`: unknown (`takenAt` is null). Exactly then.
 */
export const PHOTO_DATE_SOURCES = ['sidecar', 'exif', 'exif-local', 'file-modified', 'none'] as const;
export type PhotoDateSource = (typeof PHOTO_DATE_SOURCES)[number];

export const isPhotoDateSource = (value: unknown): value is PhotoDateSource =>
  typeof value === 'string' && (PHOTO_DATE_SOURCES as readonly string[]).includes(value);

/** How much a date can be trusted (higher wins when the same bytes are seen twice). */
const DATE_RANK: Record<PhotoDateSource, number> = { sidecar: 4, exif: 3, 'exif-local': 2, 'file-modified': 1, none: 0 };

/**
 * The more trustworthy of two dates. On equal trust the choice is deterministic and does not depend
 * on the order the copies were met: the earlier `takenAt` (a missing one last), then the smaller
 * offset, then the smaller file name.
 */
export const betterDate = <T extends { dateSource: PhotoDateSource; takenAt: string | null; takenOffsetMinutes: number | null; fileName: string }>(a: T, b: T): T => {
  if (DATE_RANK[a.dateSource] !== DATE_RANK[b.dateSource]) return DATE_RANK[b.dateSource] > DATE_RANK[a.dateSource] ? b : a;
  if (a.takenAt !== b.takenAt) return b.takenAt !== null && (a.takenAt === null || b.takenAt < a.takenAt) ? b : a;
  if (a.takenOffsetMinutes !== b.takenOffsetMinutes) return b.takenOffsetMinutes !== null && (a.takenOffsetMinutes === null || b.takenOffsetMinutes < a.takenOffsetMinutes) ? b : a;
  return b.fileName < a.fileName ? b : a;
};

export interface PhotoDisplayDate {
  /** `YYYY-MM-DD`. */
  day: string;
  /** `HH:MM`; present when the hour is meaningful (always, today). */
  time: string;
  /**
   * `local-digits`: the camera's own wall clock, shown exactly as written, never converted.
   * `utc`: a UTC instant already converted to the viewer's zone (by `zoneOffsetMinutes`).
   */
  zone: 'utc' | 'local-digits';
  /** True for a guess (`file-modified`): show it as "about", never as the original date. */
  approximate: boolean;
}

/**
 * The ONE rule for showing a photo's date (screens must not re-derive it from `takenAt`):
 * - `exif` with `takenOffsetMinutes`: `takenAt` is a UTC instant and the offset is the camera's own,
 *   so the wall clock at the place of the photo is `takenAt + offset`, shown as written (`local-digits`).
 *   This keeps a 00:30 photo at +10:00 on its own day instead of the previous UTC day.
 * - `exif-local`: `takenAt` already holds the wall-clock digits; shown as written (`local-digits`).
 * - `sidecar` (Google gives only a UTC instant) and `file-modified`: shown in the viewer's zone
 *   (`utc`); `zoneOffsetMinutes(epochMs)` gives that zone's offset at that instant (default 0), e.g.
 *   `(ms) => -new Date(ms).getTimezoneOffset()`. `file-modified` is `approximate`.
 * - `none` (no `takenAt`): null, the date is unknown.
 */
export function photoDisplayDate(
  item: { takenAt: string | null; dateSource: PhotoDateSource; takenOffsetMinutes: number | null },
  zoneOffsetMinutes: (epochMs: number) => number = () => 0,
): PhotoDisplayDate | null {
  if (item.takenAt === null || item.dateSource === 'none') return null;
  const ms = Date.parse(item.takenAt);
  if (Number.isNaN(ms)) return null;
  const digits = (shiftMinutes: number, zone: PhotoDisplayDate['zone']): PhotoDisplayDate => {
    const iso = new Date(ms + shiftMinutes * 60_000).toISOString();
    return { day: iso.slice(0, 10), time: iso.slice(11, 16), zone, approximate: isGuessedDate(item.dateSource) };
  };
  if (item.dateSource === 'exif-local') return digits(0, 'local-digits');
  if (item.dateSource === 'exif' && item.takenOffsetMinutes !== null) return digits(item.takenOffsetMinutes, 'local-digits');
  return digits(zoneOffsetMinutes(ms), 'utc');
}

/** The camera's UTC offset in minutes limit (+14:00), and the minutes real zones use. */
export const PHOTO_OFFSET_MAX_MINUTES = 14 * 60;

/** True for a camera UTC offset in minutes: a multiple of 15 within +-14:00 (zones use :00, :30, :45). */
export const isPhotoOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= PHOTO_OFFSET_MAX_MINUTES && value % 15 === 0;

/** True for a date that is only a guess (see `PHOTO_DATE_SOURCES`). */
export const isGuessedDate = (source: PhotoDateSource): boolean => source === 'file-modified';

/**
 * A file's last-modified time (epoch milliseconds) as a `takenAt` instant, or null when it cannot
 * be a real date: not a positive finite number, before 1971 (0 and tiny values are "unset"), or
 * more than a day after `nowMs`.
 */
export function takenAtFromEpochMs(ms: unknown, nowMs: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 365 * 86_400_000 || ms > nowMs + 86_400_000) return null;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

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
  /**
   * The camera's UTC offset in minutes when `dateSource` is `exif` (OffsetTimeOriginal), else null.
   * With it, `photoDisplayDate` recovers the wall-clock day at the place of the photo.
   */
  takenOffsetMinutes: number | null;
  /** Where `takenAt` came from; `none` exactly when `takenAt` is null. */
  dateSource: PhotoDateSource;
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
