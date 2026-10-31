import type { PhotoKind } from '../../domain/photo';
import { PHOTO_ALBUM_MAX, PHOTO_FILE_NAME_MAX, truncateCodePoints } from '../../domain/photo';

/**
 * Paths and file names inside a Google Photos Takeout ZIP. Everything here is untrusted text.
 * No name ever becomes a storage path (media is stored by the hash of its bytes); the checks
 * keep a hostile name from ever being treated as one anyway, and keep what is shown readable.
 */

export type TakeoutErrorCode =
  /** Not a readable ZIP, or nothing in it that is a picture or a video. */
  | 'invalid-takeout'
  /** An entry name could escape the archive (`..`, absolute, drive letter, backslash, control characters). */
  | 'unsafe-path'
  /** Every chosen file failed to read (cloud-only, removed or changed after it was picked). */
  | 'unreadable-files'
  /** More entries, or bigger entries, than the limits allow. */
  | 'limit-exceeded';

/** A problem with the Takeout file. Messages never contain file names or text from the archive. */
export class TakeoutError extends Error {
  readonly code: TakeoutErrorCode;
  constructor(code: TakeoutErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TakeoutError';
    this.code = code;
  }
}

const MAX_PATH_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** A surrogate half with no partner (never valid text). */
const LONE_SURROGATE = /\p{Cs}/gu;
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Refuses an entry name that could ever be read as a path outside the archive. Unlike the backup
 * format, Takeout names have spaces and non-ASCII letters ("Google Fotos", "Viatge a Lisboa"), so
 * those are fine; traversal, absolute paths, drive letters, backslashes and control characters
 * are not. A trailing `/` (a folder entry) is allowed.
 */
export function checkTakeoutPath(name: string): void {
  const bad = (why: string) => new TakeoutError('unsafe-path', `unsafe entry path in the archive (${why})`);
  if (name.length === 0 || name.length > MAX_PATH_CHARS) throw bad('length');
  if (CONTROL.test(name)) throw bad('control characters');
  if (name.includes('\\')) throw bad('backslash');
  if (name.startsWith('/')) throw bad('absolute');
  if (/^[a-zA-Z]:/.test(name)) throw bad('drive letter');
  const body = name.endsWith('/') ? name.slice(0, -1) : name;
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw bad('segment');
  }
}

/**
 * Text that is going to be stored and shown: control characters out, lone surrogates replaced,
 * normalized to NFC (so "é" typed two ways is one album), trimmed, cut at `max` code points
 * (never inside a surrogate pair). Case is kept.
 */
export function cleanText(value: string, max: number): string {
  const cleaned = value.replace(CONTROL_G, ' ').replace(LONE_SURROGATE, '\ufffd').normalize('NFC').trim();
  return truncateCodePoints(cleaned, max);
}

// A Map, not an object: a file called `a.constructor` or `a.__proto__` must not find inherited members.
const MEDIA_TYPES: ReadonlyMap<string, { kind: PhotoKind; mime: string }> = new Map(Object.entries({
  jpg: { kind: 'photo', mime: 'image/jpeg' },
  jpeg: { kind: 'photo', mime: 'image/jpeg' },
  png: { kind: 'photo', mime: 'image/png' },
  gif: { kind: 'photo', mime: 'image/gif' },
  webp: { kind: 'photo', mime: 'image/webp' },
  heic: { kind: 'photo', mime: 'image/heic' },
  heif: { kind: 'photo', mime: 'image/heif' },
  avif: { kind: 'photo', mime: 'image/avif' },
  bmp: { kind: 'photo', mime: 'image/bmp' },
  tif: { kind: 'photo', mime: 'image/tiff' },
  tiff: { kind: 'photo', mime: 'image/tiff' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/x-m4v' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  '3gp': { kind: 'video', mime: 'video/3gpp' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  webm: { kind: 'video', mime: 'video/webm' },
  mpg: { kind: 'video', mime: 'video/mpeg' },
  mpeg: { kind: 'video', mime: 'video/mpeg' },
} satisfies Record<string, { kind: PhotoKind; mime: string }>));

/** The kind and media type a file name's extension says, or null for anything that is not a picture or video we keep. */
export function mediaTypeOf(fileName: string): { kind: PhotoKind; mime: string } | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  return MEDIA_TYPES.get(fileName.slice(dot + 1).toLowerCase()) ?? null;
}

export type EntryClass =
  | { type: 'media'; kind: PhotoKind; mime: string }
  | { type: 'album-metadata' }
  | { type: 'sidecar' }
  | { type: 'ignored' };

/** What an entry is, by its base name alone. */
export function classifyEntry(baseName: string): EntryClass {
  const media = mediaTypeOf(baseName);
  if (media) return { type: 'media', ...media };
  const lower = baseName.toLowerCase();
  if (lower === 'metadata.json') return { type: 'album-metadata' };
  if (lower.endsWith('.json')) return { type: 'sidecar' };
  return { type: 'ignored' };
}

export interface SplitPath {
  /** Folder segments, outermost first. */
  dirs: string[];
  baseName: string;
}

export function splitPath(name: string): SplitPath {
  const parts = name.split('/');
  return { dirs: parts.slice(0, -1), baseName: parts[parts.length - 1] };
}

const YEAR_FOLDER = /^Photos from \d{4}$/;

/**
 * The album a file is in: its folder. With the usual `Takeout/<service folder>/<album>/file`
 * layout the first folder after `Takeout` is the service folder (named after the language of the
 * Google account: "Google Photos", "Google Fotos"), so a file directly in it is in no album, and
 * so is a file in a year folder ("Photos from 2019": Google's automatic grouping, not an album).
 * Without a `Takeout` wrapper the folder is the album. The album folder name is only a fallback:
 * the album's own `metadata.json` title wins (see `read.ts`).
 */
export function albumFolderOf(dirs: readonly string[]): { key: string; name: string } {
  const albumDirs = dirs[0] === 'Takeout' ? dirs.slice(2) : dirs;
  const last = albumDirs[albumDirs.length - 1];
  if (last === undefined || YEAR_FOLDER.test(last)) return { key: dirs.join('/'), name: '' };
  return { key: dirs.join('/'), name: cleanText(last, PHOTO_ALBUM_MAX) };
}

/** A file name safe to store and show: its base name only, cleaned and bounded. */
export function displayFileName(baseName: string): string {
  return cleanText(baseName, PHOTO_FILE_NAME_MAX) || 'file';
}
