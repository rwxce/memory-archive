/**
 * `BlobStore` on the browser's origin-private file system (OPFS).
 *
 * Layout under the root, in the dedicated directory `memory-archive-blobs/`:
 *   tmp/<uuid>.tmp        a write in progress (never visible as a blob)
 *   tmp/pending-<sha>     marker, only while the no-`move()` fallback copies a blob
 *   <aa>/<sha256>         the blob, sharded by the first two hex characters
 *
 * Writes: bytes stream into `tmp/`, hashed on the way (`createSha256`), then the file is
 * moved into its shard with `FileSystemFileHandle.move()`: an atomic rename, so a blob is
 * either absent or complete. Browsers without `move()` take a fallback: copy into the
 * final name, rehash, and delete it if it does not verify. That window is not atomic, so
 * a `pending-<sha>` marker is written first and `openBlobStore` re-verifies (and deletes
 * when bad) every marked blob on the next open.
 *
 * Sinks: `createWritable()` when the browser has it (its swap file only replaces content
 * on `close()`), else `createSyncAccessHandle()` (workers only). At least one must exist.
 *
 * One sweeper at a time: `openBlobStore` sweeps `tmp/` by default, which deletes every
 * temp file in it, so only the thread that owns the library (the page) opens with the
 * default. The library itself opens with `{ sweep: false }` and calls `sweepTemp()` only while it
 * holds the archive lock (`sweepLeftovers`): a reload or a second tab must not delete the temp
 * files of an import worker that is still writing. A second thread that writes blobs at the same time (the import worker) opens with
 * `{ sweep: false }`: it must not delete the other's in-flight temp files, and the page's next
 * open removes whatever a crashed worker left. Their temp names are random UUIDs, so two live
 * stores never collide in `tmp/`.
 *
 * The structural handle types below are the subset used, so the adapter runs against the
 * in-memory directory in `test-opfs-directory.ts` under Node.
 */

import { isSha256Hex } from '../domain/library';
import { createSha256 } from '../domain/sha256';
import {
  BlobStoreError,
  type BlobInfo,
  type BlobSource,
  type BlobStore,
  type BlobVerification,
} from './blob-store';

/** Part of the on-device format: renaming it orphans every stored blob. */
export const BLOBS_DIRECTORY = 'memory-archive-blobs';
const TMP_DIRECTORY = 'tmp';
const TMP_SUFFIX = '.tmp';
const PENDING_PREFIX = 'pending-';

export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface OpfsSyncAccessHandle {
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<OpfsWritable>;
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
  move?(destination: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
}

interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotFoundError';
}

function assertHash(sha256: string): void {
  if (!isSha256Hex(sha256)) throw new BlobStoreError('invalid-hash', 'blob name must be 64 lowercase hex characters');
}

/** Exported for tests and for the thumbnail cache, which writes the same way. */
export async function openSink(file: OpfsFileHandle): Promise<Sink> {
  if (file.createWritable) {
    const writable = await file.createWritable();
    return { write: (chunk) => writable.write(chunk), close: () => writable.close(), abort: () => writable.abort() };
  }
  if (file.createSyncAccessHandle) {
    const handle = await file.createSyncAccessHandle();
    // A sync access handle keeps existing bytes: start from an empty file, like createWritable.
    handle.truncate(0);
    let at = 0;
    return {
      async write(chunk) {
        let done = 0;
        while (done < chunk.length) {
          const written = handle.write(chunk.subarray(done), { at: at + done });
          if (written <= 0) throw new BlobStoreError('io', 'short write to the file system');
          done += written;
        }
        at += chunk.length;
      },
      async close() {
        handle.flush();
        handle.close();
      },
      async abort() {
        handle.close();
      },
    };
  }
  throw new BlobStoreError('unsupported', 'this browser cannot write files in the origin-private file system');
}

/** Pull chunks with a reader (async iteration of streams is not available everywhere). */
async function* readChunks(source: BlobSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (!(source instanceof ReadableStream)) {
    throw new BlobStoreError('invalid-source', 'a blob source is a Uint8Array or a ReadableStream of Uint8Array');
  }
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) {
        throw new BlobStoreError('invalid-source', 'blob stream chunks must be Uint8Array');
      }
      yield value;
    }
  } finally {
    // Reached on error or early exit: tell the producer to stop.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hasher = createSha256();
  for await (const chunk of readChunks(stream)) hasher.update(chunk);
  return hasher.digestHex();
}

async function ignore(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

export interface OpenBlobStoreOptions {
  /** Sweep abandoned writes in `tmp/` on open (default). `false` for a second, concurrent opener. */
  sweep?: boolean;
}

/** Open the store in `root` (any OPFS-shaped directory) and sweep abandoned writes (see `sweep`). */
export async function openBlobStore(root: OpfsDirectoryHandle, options: OpenBlobStoreOptions = {}): Promise<BlobStore> {
  const base = await root.getDirectoryHandle(BLOBS_DIRECTORY, { create: true });
  const tmp = await base.getDirectoryHandle(TMP_DIRECTORY, { create: true });

  async function find(sha256: string): Promise<OpfsFileHandle | undefined> {
    assertHash(sha256);
    try {
      const shard = await base.getDirectoryHandle(sha256.slice(0, 2));
      return await shard.getFileHandle(sha256);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async function verify(sha256: string): Promise<BlobVerification> {
    const file = await find(sha256);
    if (!file) return 'missing';
    return (await hashStream((await file.getFile()).stream())) === sha256 ? 'ok' : 'corrupt';
  }

  async function remove(sha256: string): Promise<boolean> {
    assertHash(sha256);
    try {
      const shard = await base.getDirectoryHandle(sha256.slice(0, 2));
      await shard.removeEntry(sha256);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Recovery from a crash: drop abandoned temp files, re-verify blobs a fallback copy was writing. */
  async function sweep(): Promise<void> {
    const names: string[] = [];
    for await (const [name, handle] of tmp.entries()) if (handle.kind === 'file') names.push(name);
    for (const name of names) {
      if (name.startsWith(PENDING_PREFIX)) {
        const sha256 = name.slice(PENDING_PREFIX.length);
        if (isSha256Hex(sha256)) {
          // A blob we cannot even read counts as corrupt. A failed cleanup is left for the next sweep.
          const state = await verify(sha256).catch((): BlobVerification => 'corrupt');
          if (state !== 'ok') await ignore(remove(sha256));
        }
      }
      await ignore(tmp.removeEntry(name));
    }
  }

  /** Make a complete temp file visible as `<aa>/<sha>`. */
  async function publish(file: OpfsFileHandle, sha256: string): Promise<void> {
    const shard = await base.getDirectoryHandle(sha256.slice(0, 2), { create: true });
    if (file.move) {
      await file.move(shard, sha256);
      return;
    }
    const marker = `${PENDING_PREFIX}${sha256}`;
    await tmp.getFileHandle(marker, { create: true });
    const sink = await openSink(await shard.getFileHandle(sha256, { create: true }));
    try {
      for await (const chunk of readChunks((await file.getFile()).stream())) await sink.write(chunk);
      await sink.close();
    } catch (error) {
      await ignore(sink.abort());
      await ignore(remove(sha256));
      await ignore(tmp.removeEntry(marker));
      throw error;
    }
    if ((await verify(sha256)) !== 'ok') {
      await ignore(remove(sha256));
      await ignore(tmp.removeEntry(marker));
      throw new BlobStoreError('io', 'copied blob did not verify');
    }
    await tmp.removeEntry(marker);
  }

  async function putOne(source: BlobSource): Promise<BlobInfo> {
    const tmpName = `${crypto.randomUUID()}${TMP_SUFFIX}`;
    const file = await tmp.getFileHandle(tmpName, { create: true });
    try {
      const hasher = createSha256();
      let size = 0;
      const sink = await openSink(file);
      try {
        for await (const chunk of readChunks(source)) {
          hasher.update(chunk);
          await sink.write(chunk);
          size += chunk.length;
        }
        await sink.close();
      } catch (error) {
        await ignore(sink.abort());
        throw error;
      }
      const sha256 = hasher.digestHex();
      const existing = await find(sha256);
      // Same hash and same size: already stored, kept as is. Only a size-mismatched copy is
      // replaced; same-size bit-rot is not healed here, `verify()` is what detects it.
      if (existing && (await existing.getFile()).size === size) {
        await tmp.removeEntry(tmpName);
        return { sha256, size };
      }
      if (existing) await remove(sha256);
      await publish(file, sha256);
      await ignore(tmp.removeEntry(tmpName)); // already gone after move(); the copy fallback leaves it
      return { sha256, size };
    } catch (error) {
      await ignore(tmp.removeEntry(tmpName));
      throw error;
    }
  }

  // Puts run one at a time: two writers of the same content would race on the final name
  // (and on the fallback's marker). ZIP entries arrive sequentially anyway.
  let lastPut: Promise<unknown> = Promise.resolve();
  function put(source: BlobSource): Promise<BlobInfo> {
    const result = lastPut.then(() => putOne(source));
    lastPut = result.catch(() => undefined);
    return result;
  }

  if (options.sweep !== false) await sweep();

  return {
    put,
    async has(sha256) {
      return (await find(sha256)) !== undefined;
    },
    async open(sha256) {
      const file = await find(sha256);
      return file ? (await file.getFile()).stream() : undefined;
    },
    async size(sha256) {
      const file = await find(sha256);
      return file ? (await file.getFile()).size : undefined;
    },
    delete: remove,
    async list() {
      const out: string[] = [];
      for await (const [shardName, shard] of base.entries()) {
        if (shard.kind !== 'directory' || shardName === TMP_DIRECTORY) continue;
        for await (const [name, handle] of shard.entries()) {
          if (handle.kind === 'file' && isSha256Hex(name) && name.startsWith(shardName)) out.push(name);
        }
      }
      return out.sort();
    },
    verify,
    sweepTemp: sweep,
  };
}

/** The real OPFS of this origin. Browser only (window or worker). */
export async function openOpfsBlobStore(options: OpenBlobStoreOptions = {}): Promise<BlobStore> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage?.getDirectory) throw new BlobStoreError('unsupported', 'the origin-private file system is not available');
  return openBlobStore((await storage.getDirectory()) as unknown as OpfsDirectoryHandle, options);
}
