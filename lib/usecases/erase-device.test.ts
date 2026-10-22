import { describe, expect, test, vi } from 'vitest';
import { OPFS_DB_FILE, OPFS_DIRECTORY, OPFS_SEARCH_FILE } from '../db/opfs-names';
import { BLOBS_DIRECTORY, type OpfsDirectoryHandle } from '../storage/opfs-blob-store';
import { THUMBS_DIRECTORY } from '../storage/opfs-thumb-store';
import { SHARE_INBOX_CACHE, listSharedFiles, storeSharedFiles } from '../storage/share-inbox';
import { createMemoryCacheStorage } from '../storage/test-cache-storage';
import { createMemoryDirectory } from '../storage/test-opfs-directory';
import { eraseDevice } from './erase-device';

const DB_DIR = OPFS_DIRECTORY.replace(/^\/+/, '');

async function populate(root: OpfsDirectoryHandle) {
  for (const [dir, files] of [
    [DB_DIR, [OPFS_DB_FILE.slice(1), OPFS_SEARCH_FILE.slice(1)]],
    [BLOBS_DIRECTORY, ['ab']],
    [THUMBS_DIRECTORY, ['cd']],
    ['unrelated', ['keep']],
  ] as const) {
    const d = await root.getDirectoryHandle(dir, { create: true });
    for (const f of files) await d.getFileHandle(f, { create: true });
  }
}

const names = async (root: OpfsDirectoryHandle) => {
  const out: string[] = [];
  for await (const [name] of root.entries()) out.push(name);
  return out.sort();
};

function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('eraseDevice', () => {
  test('erases OPFS directories, share inbox and prefixed keys; leaves the rest', async () => {
    const root = createMemoryDirectory();
    await populate(root);
    const cacheStorage = createMemoryCacheStorage();
    await storeSharedFiles(cacheStorage, 'https://x.example/', [new File(['z'], 'c.zip', { type: 'application/zip' })]);
    await cacheStorage.open('serwist-precache-v2');
    const local = fakeStorage({ 'memory-archive:theme': 'dark', 'memory-archive:position:1': '3', other: 'x' });
    const session = fakeStorage({ 'memory-archive:a': '1', 'memory-archive:b': '2', keep: '1' });
    const close = vi.fn();

    const result = await eraseDevice({ library: { close }, root, cacheStorage, localStorage: local, sessionStorage: session });

    expect(result).toEqual({ complete: true, failed: [] });
    expect(close).toHaveBeenCalledWith({ force: true });
    expect(await names(root)).toEqual(['unrelated']);
    expect(await listSharedFiles(cacheStorage)).toEqual([]);
    expect(await cacheStorage.has(SHARE_INBOX_CACHE)).toBe(false);
    expect(await cacheStorage.has('serwist-precache-v2')).toBe(true);
    expect([...local.map.keys()]).toEqual(['other']);
    expect([...session.map.keys()]).toEqual(['keep']);
  });

  test('is idempotent and tolerates missing directories, caches and APIs', async () => {
    const root = createMemoryDirectory();
    expect(await eraseDevice({ root, cacheStorage: createMemoryCacheStorage() })).toEqual({ complete: true, failed: [] });
    expect(await eraseDevice({})).toEqual({ complete: true, failed: [] });
  });

  test('keeps going and reports what failed; closing errors are ignored', async () => {
    const root = createMemoryDirectory();
    await populate(root);
    const real = root.removeEntry.bind(root);
    root.removeEntry = async (name, options) => {
      if (name === BLOBS_DIRECTORY) throw new DOMException('locked', 'NoModificationAllowedError');
      return real(name, options);
    };
    const result = await eraseDevice({
      library: {
        close: () => {
          throw new Error('closed');
        },
      },
      root,
      retryDelayMs: 0,
    });
    expect(result).toEqual({ complete: false, failed: ['media'] });
    expect(await names(root)).toEqual([BLOBS_DIRECTORY, 'unrelated']);
  });

  test('retries a directory still held by the closing worker', async () => {
    const root = createMemoryDirectory();
    await populate(root);
    const real = root.removeEntry.bind(root);
    let calls = 0;
    root.removeEntry = async (name, options) => {
      if (name === DB_DIR && calls++ < 2) throw new DOMException('held', 'NoModificationAllowedError');
      return real(name, options);
    };
    expect(await eraseDevice({ root, retryDelayMs: 0 })).toEqual({ complete: true, failed: [] });
    expect(await names(root)).toEqual(['unrelated']);
  });
});
