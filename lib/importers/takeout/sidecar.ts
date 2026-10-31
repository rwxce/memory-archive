import { PHOTO_ALBUM_MAX, PHOTO_DESCRIPTION_MAX, truncateCodePoints } from '../../domain/photo';
import { cleanText } from './paths';

/**
 * Reads a Takeout sidecar (`<file>.json`, `<file>.supplemental-metadata.json`) and the album's
 * `metadata.json`. Both are untrusted: a size bound before reading, strict UTF-8, and every field
 * type-checked and range-checked. A field that is wrong is dropped on its own; the picture is
 * still imported. Fields we do not use (people, url, favorited, device folders...) are ignored on
 * purpose: see `docs/formats/photo-library.md`.
 */

/** Sidecars are a few hundred bytes; a bigger one is not one. */
export const MAX_SIDECAR_BYTES = 256 * 1024;

export interface PhotoMetadata {
  /** The file name Google had for the picture; used only to confirm a match, never stored or used as a path. */
  title: string | null;
  /** UTC instant the picture was taken (`photoTakenTime`), or null. Upload date (`creationTime`) is deliberately not used. */
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_SIDECAR_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/** Epoch seconds as Google writes them (a decimal string) or a number, as a UTC instant; year 1970-9999 only. */
export function epochToTakenAt(value: unknown): string | null {
  const seconds = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253_402_300_799) return null;
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

function place(raw: unknown): { latitude: number; longitude: number } | null {
  if (!isObject(raw)) return null;
  const { latitude, longitude } = raw;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // Google writes 0, 0 for "no location".
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/** The metadata of one picture, or null when the file is not a JSON object at all. */
export function parseSidecar(bytes: Uint8Array): PhotoMetadata | null {
  const raw = parseJson(bytes);
  if (!isObject(raw)) return null;
  const taken = isObject(raw.photoTakenTime) ? epochToTakenAt(raw.photoTakenTime.timestamp) : null;
  // `geoData` is what the person may have edited; `geoDataExif` is what the camera recorded.
  const where = place(raw.geoData) ?? place(raw.geoDataExif);
  return {
    title: typeof raw.title === 'string' && raw.title.length <= 1000 ? raw.title : null,
    takenAt: taken,
    latitude: where?.latitude ?? null,
    longitude: where?.longitude ?? null,
    description: typeof raw.description === 'string' ? cleanTextKeepingLines(raw.description) : '',
  };
}

/** A description may have line breaks; every other control character goes. */
function cleanTextKeepingLines(value: string): string {
  const joined = value
    .split(/\r\n|\r|\n/)
    .map((line) => cleanText(line, PHOTO_DESCRIPTION_MAX))
    .join('\n')
    .trim();
  return truncateCodePoints(joined, PHOTO_DESCRIPTION_MAX);
}

/** The album's own title from `metadata.json`, or null. */
export function parseAlbumTitle(bytes: Uint8Array): string | null {
  const raw = parseJson(bytes);
  if (!isObject(raw) || typeof raw.title !== 'string') return null;
  const title = cleanText(raw.title, PHOTO_ALBUM_MAX);
  return title === '' ? null : title;
}
