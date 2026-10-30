/**
 * Share inbox: files another app (WhatsApp's "Export chat" → share) sent to
 * the installed PWA through the Web Share Target. The service worker receives
 * the POST before any page exists, so the files wait in Cache Storage (the one
 * store both the worker and the pages can reach) until the import wizard
 * (Phase 4) takes them.
 *
 * Shared files are untrusted: names are kept only as metadata (never used as
 * a path), only ZIP, plain-text and old backup output files (JSON, HTML, CSV) are accepted; the import decides by content, and the count is bounded.
 */

export const SHARE_INBOX_CACHE = 'memory-archive-share-inbox-v1';
/** Cache keys live under this path of the app scope; never fetched from a server. */
export const SHARE_INBOX_PATH = '__share-inbox__/';
/** At most this many files per share (a chat export is one ZIP or one TXT). */
export const MAX_SHARED_FILES = 20;

const ACCEPTED_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'text/plain', 'application/json', 'text/html', 'text/csv']);
const ACCEPTED_EXTENSIONS = /\.(zip|txt|json|html?|csv)$/i;

export interface SharedFileInfo {
  /** Cache key (URL) of the stored file. */
  key: string;
  name: string;
  type: string;
  size: number;
  receivedAt: number;
}

/** ZIP, plain text or an old backup output, by MIME type or, when the sender gives none, by extension. */
export function isAcceptedSharedFile(file: Pick<File, 'name' | 'type'>): boolean {
  const type = file.type.split(';')[0].trim().toLowerCase();
  if (ACCEPTED_TYPES.has(type)) return true;
  return (type === '' || type === 'application/octet-stream') && ACCEPTED_EXTENSIONS.test(file.name);
}

/**
 * Store accepted files in the inbox. Returns how many were stored (rejected
 * and over-limit files are skipped, never stored).
 */
export async function storeSharedFiles(
  cacheStorage: CacheStorage,
  scopeUrl: string,
  files: readonly File[],
  now: number = Date.now(),
): Promise<number> {
  const accepted = files.filter(isAcceptedSharedFile).slice(0, MAX_SHARED_FILES);
  if (accepted.length === 0) return 0;
  const cache = await cacheStorage.open(SHARE_INBOX_CACHE);
  let i = 0;
  for (const file of accepted) {
    const key = new URL(`${SHARE_INBOX_PATH}${now}-${i++}`, scopeUrl).href;
    await cache.put(
      key,
      new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'content-length': String(file.size),
          'x-memory-archive-name': encodeURIComponent(file.name),
          'x-memory-archive-received': String(now),
        },
      }),
    );
  }
  return accepted.length;
}

/** Everything waiting in the inbox, oldest first. */
export async function listSharedFiles(cacheStorage: CacheStorage): Promise<SharedFileInfo[]> {
  if (!(await cacheStorage.has(SHARE_INBOX_CACHE))) return [];
  const cache = await cacheStorage.open(SHARE_INBOX_CACHE);
  const out: SharedFileInfo[] = [];
  for (const request of await cache.keys()) {
    const res = await cache.match(request);
    if (!res) continue;
    let name: string;
    try {
      name = decodeURIComponent(res.headers.get('x-memory-archive-name') ?? '');
    } catch {
      name = '';
    }
    out.push({
      key: request.url,
      name,
      type: res.headers.get('content-type') ?? '',
      size: Number(res.headers.get('content-length') ?? 0),
      receivedAt: Number(res.headers.get('x-memory-archive-received') ?? 0),
    });
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt || a.key.localeCompare(b.key));
}

/** Read one stored file back as a `File` (for the import wizard). */
export async function readSharedFile(cacheStorage: CacheStorage, info: SharedFileInfo): Promise<File | undefined> {
  const cache = await cacheStorage.open(SHARE_INBOX_CACHE);
  const res = await cache.match(info.key);
  if (!res) return undefined;
  return new File([await res.blob()], info.name, { type: info.type, lastModified: info.receivedAt });
}

/** Forget one stored file (after it was imported or dismissed). */
export async function removeSharedFile(cacheStorage: CacheStorage, key: string): Promise<boolean> {
  const cache = await cacheStorage.open(SHARE_INBOX_CACHE);
  return cache.delete(key);
}
