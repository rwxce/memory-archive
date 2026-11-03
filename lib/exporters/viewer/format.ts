import { GENERATOR_NAME } from '../legacy/version';

/**
 * Viewer data: the versioned JSON the standalone read-only viewer reads (docs/formats/viewer-data.md).
 * It is an export, never the storage format: nothing here is restored from. The viewer opens from
 * disk (`file://`, where `fetch` is blocked), so the JSON is inlined in the HTML as
 * `<script type="application/json">`; `serializeViewerData` makes that safe.
 *
 * Text, author, title and file names are untrusted data, kept verbatim. Escaping is the renderer's job.
 */

export const VIEWER_DATA_FORMAT = 'memory-archive-viewer';
/** Bumped only when an older viewer could misread newer data; readers refuse newer versions. */
export const VIEWER_SCHEMA_VERSION = 1;

export interface ViewerProfile {
  id: string;
  displayName: string;
  relationship: string;
  description: string;
}

export interface ViewerMessage {
  /** Local wall-clock time `YYYY-MM-DDTHH:MM:SS`, as stored. */
  sentAt: string;
  type: string;
  /** Author as named by the source; null for system messages. */
  author: string | null;
  isMe: boolean;
  /** The message text as stored ('' for a bare media message). */
  text: string;
  /** Relative path `media/<sha256>.<ext>` of a file included in the export; null otherwise. */
  media: string | null;
  /** Original file name (untrusted, display only), or ''. Set with `media === null` when the file is not included. */
  mediaName: string;
}

export interface ViewerConversation {
  id: string;
  title: string;
  source: string;
  isGroup: boolean;
  /** Selected profiles this conversation is filed under. */
  profileIds: string[];
  participants: { name: string; isMe: boolean }[];
  /** Chronological. */
  messages: ViewerMessage[];
}

export interface ViewerMedia {
  sha256: string;
  /** `media/<sha256>.<ext>`, relative to the HTML file. */
  path: string;
  size: number;
  /** Media type, or null when unknown. */
  mime: string | null;
}

export interface ViewerData {
  format: typeof VIEWER_DATA_FORMAT;
  schemaVersion: number;
  generator: { name: string; version: string };
  /** UTC instant (ISO 8601) the export was made. */
  createdAt: string;
  selection: {
    /** Local dates `YYYY-MM-DD`, inclusive; null = open. */
    from: string | null;
    to: string | null;
    includeMedia: boolean;
  };
  profiles: ViewerProfile[];
  conversations: ViewerConversation[];
  media: ViewerMedia[];
}

export type ViewerDataErrorCode = 'invalid' | 'newer-schema';

/** Messages never contain chat text, names or file names. */
export class ViewerDataError extends Error {
  readonly code: ViewerDataErrorCode;
  constructor(code: ViewerDataErrorCode, message: string) {
    super(message);
    this.name = 'ViewerDataError';
    this.code = code;
  }
}

const MEDIA_PATH = /^media\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

/**
 * `media/<sha256>.<ext>`. The extension is only a hint for the browser; it is reduced to
 * `[a-z0-9]` (at most 8 characters) from the original name, else the media type, else `bin`, so a
 * hostile file name can never shape the path.
 */
export function viewerMediaPath(sha256: string, hint: { name?: string; mime?: string | null }): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(hint.name ?? '')?.[1]?.toLowerCase();
  const fromMime = hint.mime && Object.hasOwn(MIME_EXTENSION, hint.mime) ? MIME_EXTENSION[hint.mime] : undefined;
  return `media/${sha256}.${fromName ?? fromMime ?? 'bin'}`;
}

/**
 * JSON text safe to put inside `<script type="application/json">`: `<`, `>` and `&` are written as
 * `\uXXXX` (so `</script>` and `<!--` cannot appear) and U+2028/2029 too. `JSON.parse` returns the
 * original data.
 */
export function serializeViewerData(data: ViewerData): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads viewer data back (what the viewer does with the inlined island). Refuses anything that is
 * not this format, a newer `schemaVersion` with its own code, and checks the structure the viewer
 * relies on: arrays, and media paths that stay inside `media/`.
 */
export function parseViewerData(text: string): ViewerData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ViewerDataError('invalid', 'viewer data is not valid JSON');
  }
  if (!isObject(value) || value.format !== VIEWER_DATA_FORMAT) throw new ViewerDataError('invalid', 'not viewer data');
  const version = value.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new ViewerDataError('invalid', 'schemaVersion is not valid');
  if (version > VIEWER_SCHEMA_VERSION) {
    throw new ViewerDataError('newer-schema', `viewer data schema ${version} is newer than this reader supports (${VIEWER_SCHEMA_VERSION})`);
  }
  if (!isObject(value.generator) || value.generator.name !== GENERATOR_NAME) throw new ViewerDataError('invalid', 'generator is not valid');
  if (!isObject(value.selection) || !Array.isArray(value.profiles) || !Array.isArray(value.conversations) || !Array.isArray(value.media)) {
    throw new ViewerDataError('invalid', 'viewer data is missing a section');
  }
  for (const m of value.media) {
    if (!isObject(m) || typeof m.path !== 'string' || !MEDIA_PATH.test(m.path)) throw new ViewerDataError('invalid', 'media path is not valid');
  }
  for (const c of value.conversations) {
    if (!isObject(c) || !Array.isArray(c.messages) || !Array.isArray(c.participants)) throw new ViewerDataError('invalid', 'conversation is not valid');
    for (const msg of c.messages) {
      if (!isObject(msg) || typeof msg.sentAt !== 'string' || typeof msg.text !== 'string') throw new ViewerDataError('invalid', 'message is not valid');
      if (msg.media !== null && (typeof msg.media !== 'string' || !MEDIA_PATH.test(msg.media))) throw new ViewerDataError('invalid', 'media path is not valid');
    }
  }
  return value as unknown as ViewerData;
}
