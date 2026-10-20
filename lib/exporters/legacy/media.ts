import { normalizeMediaName } from '../../importers/whatsapp/media';
import type { Message } from '../../importers/whatsapp/types';

/**
 * Maximum byte size for a media file to be eligible for `--inline` base64
 * embedding (D-M6). Files larger than this, or any video, are skipped by
 * default and fall back to a relative link / placeholder.
 */
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

/** Resolve a file extension to a MIME type (no dependency). D-M4. */
export function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[e] ?? 'application/octet-stream';
}

/** Extension of a file name including the dot (`.jpg`), or `''`. */
export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(i) : '';
}

/** True when a file may be inlined as a `data:` URI (D-M6 / MEDIA-03). */
export function isInlineable(mime: string, size: number): boolean {
  return size <= INLINE_MAX_BYTES && !mime.startsWith('video/');
}

export interface MediaEntry {
  /** Relative path as referenced by renderers: `media/<file>`. */
  relPath: string;
  mime: string;
  /** Whether this file may be inlined as a `data:` URI (D-M6). */
  inlineable: boolean;
  size: number;
}

/** A file present in the output's `media/` folder. */
export interface MediaFile {
  name: string;
  size: number;
}

/**
 * Build the media map (D-M5): resolve each message's `media` ref against the
 * files available in `media/`. Refs with no file are **absent** from the map
 * (renderers treat them as missing-but-expected).
 */
export function buildMediaMap(files: MediaFile[], messages: Message[]): Map<string, MediaEntry> {
  const index = new Map<string, MediaFile>(); // normalized -> file
  for (const f of files) {
    if (f.name.startsWith('._')) continue;
    index.set(normalizeMediaName(f.name), f);
  }
  const map = new Map<string, MediaEntry>();
  for (const m of messages) {
    if (!m.media) continue;
    const hit = index.get(normalizeMediaName(m.media));
    if (!hit) continue;
    const mime = mimeFromExt(extOf(hit.name));
    map.set(m.media, {
      relPath: `media/${hit.name}`,
      mime,
      size: hit.size,
      inlineable: isInlineable(mime, hit.size),
    });
  }
  return map;
}

/** Loads a media file as a `data:` URI (provided by the caller's platform). */
export type DataUriLoader = (entry: MediaEntry) => Promise<string>;

/** Shared render options for the Markdown and HTML exporters. */
export interface RenderOptions {
  /** Resolved media (see `buildMediaMap`). Missing refs render as placeholders. */
  media?: Map<string, MediaEntry>;
  /** Embed inlineable media as `data:` URIs (requires `loadDataUri`). */
  inline?: boolean;
  loadDataUri?: DataUriLoader;
}

/** Base64-encode bytes without Node's `Buffer` (chunked to bound call args). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
