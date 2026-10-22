/**
 * `ThumbStore` on the browser's origin-private file system.
 *
 * Layout under the root, in the dedicated directory `memory-archive-thumbs/` (never inside
 * `memory-archive-blobs/`, so blob listings, orphan sweeps and verification cannot see it):
 *   <sha256>-<size>       a thumbnail (webp or jpeg bytes)
 *   tmp-<uuid>            a write in progress (removed on open)
 *
 * Writes go to `tmp-<uuid>` and are moved into place (atomic) where `move()` exists. Without it
 * the bytes are written under the final name, so `get` also checks that the file is a COMPLETE
 * webp or jpeg (RIFF length / end marker) and drops anything else: a partial write is never served.
 *
 * Cap: 128 MiB. A 320 px webp is 10-40 KB, so that holds several thousand photos, far more than
 * a screen shows, while staying a small fraction of the space the originals already take. When a
 * `put` goes over it the oldest entries (by file time, refreshed in memory on every `get`) are
 * evicted until the total fits. The size index is built on first need, not on open.
 */

import { isSha256Hex } from '../domain/library';
import { isNotFound, openSink, type OpfsDirectoryHandle } from './opfs-blob-store';
import { isThumbSize, ThumbStoreError, THUMB_SIZES, type ThumbStore, type ThumbUsage } from './thumb-store';

export const THUMBS_DIRECTORY = 'memory-archive-thumbs';
export const THUMB_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const TMP_PREFIX = 'tmp-';
const NAME = /^[0-9a-f]{64}-\d+$/;

export interface OpenThumbStoreOptions {
  /** Total size cap in bytes (default `THUMB_CACHE_MAX_BYTES`). */
  maxBytes?: number;
  /** Clock for the order of entries written in this session (tests). */
  now?: () => number;
}

function nameOf(sha256: string, size: unknown): string {
  if (!isSha256Hex(sha256)) throw new ThumbStoreError('invalid-hash', 'thumbnail name must be 64 lowercase hex characters');
  if (!isThumbSize(size)) throw new ThumbStoreError('invalid-size', 'unknown thumbnail size');
  return `${sha256}-${size}`;
}

const isCacheName = (name: string) => NAME.test(name) && isThumbSize(Number(name.slice(65)));

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

/** The media type of a COMPLETE webp or jpeg, `undefined` for anything else (including a truncated one). */
export function completeImageType(bytes: Uint8Array): 'image/webp' | 'image/jpeg' | undefined {
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    return declared + 8 === bytes.length ? 'image/webp' : undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return 'image/jpeg';
  }
  return undefined;
}

interface Entry {
  size: number;
  at: number;
}

export async function openThumbStore(root: OpfsDirectoryHandle, options: OpenThumbStoreOptions = {}): Promise<ThumbStore> {
  const maxBytes = options.maxBytes ?? THUMB_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  const base = await root.getDirectoryHandle(THUMBS_DIRECTORY, { create: true });

  const names = async (keep: (name: string) => boolean): Promise<string[]> => {
    const out: string[] = [];
    for await (const [name, handle] of base.entries()) if (handle.kind === 'file' && keep(name)) out.push(name);
    return out;
  };
  const removeQuietly = (name: string) => base.removeEntry(name).catch(() => undefined);

  // Nothing else writes here (one tab holds the library), so every temp file is abandoned.
  for (const name of await names((n) => n.startsWith(TMP_PREFIX))) await removeQuietly(name);

  let index: Map<string, Entry> | undefined;
  let total = 0;
  async function ensureIndex(): Promise<Map<string, Entry>> {
    if (index) return index;
    const built = new Map<string, Entry>();
    total = 0;
    for (const name of await names(isCacheName)) {
      try {
        const file = await (await base.getFileHandle(name)).getFile();
        built.set(name, { size: file.size, at: file.lastModified });
        total += file.size;
      } catch {
        // Unreadable: treated as absent; a `put` over it replaces it.
      }
    }
    return (index = built);
  }
  function forget(name: string) {
    const entry = index?.get(name);
    if (entry) total -= entry.size;
    index?.delete(name);
  }

  // Mutations run one at a time, like the blob store's puts.
  let last: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = last.then(work);
    last = result.catch(() => undefined);
    return result;
  }

  async function write(name: string, bytes: Uint8Array): Promise<void> {
    const tmpName = `${TMP_PREFIX}${crypto.randomUUID()}`;
    const tmp = await base.getFileHandle(tmpName, { create: true });
    try {
      const sink = await openSink(tmp);
      try {
        await sink.write(bytes);
        await sink.close();
      } catch (error) {
        await sink.abort().catch(() => undefined);
        throw error;
      }
      if (tmp.move) {
        await tmp.move(base, name);
        return;
      }
      const final = await openSink(await base.getFileHandle(name, { create: true }));
      try {
        await final.write(bytes);
        await final.close();
      } catch (error) {
        await final.abort().catch(() => undefined);
        await removeQuietly(name);
        throw error;
      }
      await removeQuietly(tmpName);
    } catch (error) {
      await removeQuietly(tmpName);
      throw error;
    }
  }

  async function evict(keep: string): Promise<void> {
    const entries = await ensureIndex();
    const oldest = [...entries].filter(([name]) => name !== keep).sort((a, b) => a[1].at - b[1].at);
    for (const [name] of oldest) {
      if (total <= maxBytes) return;
      await removeQuietly(name);
      forget(name);
    }
  }

  return {
    async get(sha256, size) {
      const name = nameOf(sha256, size);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await (await (await base.getFileHandle(name)).getFile()).arrayBuffer());
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      const type = completeImageType(bytes);
      if (!type) {
        await serial(async () => {
          await removeQuietly(name);
          forget(name);
        });
        return undefined;
      }
      const entry = index?.get(name);
      if (entry) entry.at = now();
      return new Blob([bytes as BlobPart], { type });
    },

    async put(sha256, size, thumbnail) {
      const name = nameOf(sha256, size);
      await serial(async () => {
        const bytes = new Uint8Array(await thumbnail.arrayBuffer());
        if (!completeImageType(bytes)) throw new ThumbStoreError('invalid-thumbnail', 'a thumbnail is a complete webp or jpeg');
        if (bytes.length > maxBytes) return;
        const entries = await ensureIndex();
        await write(name, bytes);
        forget(name);
        entries.set(name, { size: bytes.length, at: now() });
        total += bytes.length;
        await evict(name);
      });
    },

    async delete(sha256) {
      for (const size of THUMB_SIZES) nameOf(sha256, size);
      await serial(async () => {
        for (const size of THUMB_SIZES) {
          const name = `${sha256}-${size}`;
          await removeQuietly(name);
          forget(name);
        }
      });
    },

    clear() {
      return serial(async () => {
        for (const name of await names(() => true)) await removeQuietly(name);
        index = new Map();
        total = 0;
      });
    },

    async list() {
      return [...new Set((await names(isCacheName)).map((name) => name.slice(0, 64)))].sort();
    },

    usage(): Promise<ThumbUsage> {
      return serial(async () => ({ count: (await ensureIndex()).size, bytes: total }));
    },
  };
}

/** The real OPFS of this origin. Browser only. */
export async function openOpfsThumbStore(options: OpenThumbStoreOptions = {}): Promise<ThumbStore> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage?.getDirectory) throw new ThumbStoreError('unsupported', 'the origin-private file system is not available');
  return openThumbStore((await storage.getDirectory()) as unknown as OpfsDirectoryHandle, options);
}
