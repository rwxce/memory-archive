import { describe, expect, test } from 'vitest';
import { BLOBS_DIRECTORY, openBlobStore, type OpfsDirectoryHandle } from './opfs-blob-store';
import { completeImageType, openThumbStore, THUMBS_DIRECTORY } from './opfs-thumb-store';
import { ThumbStoreError } from './thumb-store';
import { createMemoryDirectory } from './test-opfs-directory';
import { webpBlob } from './test-thumbnail';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const webp = webpBlob;
const jpeg = (total: number) => new Blob([new Uint8Array([0xff, 0xd8, ...new Array(total - 4).fill(7), 0xff, 0xd9])]);

async function entries(dir: OpfsDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of dir.entries()) out.push(name);
  return out.sort();
}
const thumbsDir = (root: OpfsDirectoryHandle) => root.getDirectoryHandle(THUMBS_DIRECTORY);

describe('thumbnail store', () => {
  test('put then get returns the same bytes with their image type; a miss is undefined', async () => {
    const store = await openThumbStore(createMemoryDirectory());
    expect(await store.get(A, 320)).toBeUndefined();
    await store.put(A, 320, webp(100));
    const hit = await store.get(A, 320);
    expect(hit?.type).toBe('image/webp');
    expect(hit?.size).toBe(100);
    await store.put(B, 320, jpeg(50));
    expect((await store.get(B, 320))?.type).toBe('image/jpeg');
    expect(await store.usage()).toEqual({ count: 2, bytes: 150 });
  });

  test('only 64 lowercase hex hashes and known sizes become file names', async () => {
    const root = createMemoryDirectory();
    const store = await openThumbStore(root);
    for (const bad of ['../x', 'A'.repeat(64), 'a'.repeat(63), `${A}/..`, '', 'a'.repeat(64) + '-320']) {
      await expect(store.get(bad, 320)).rejects.toMatchObject({ code: 'invalid-hash' });
      await expect(store.put(bad, 320, webp(20))).rejects.toMatchObject({ code: 'invalid-hash' });
      await expect(store.delete(bad)).rejects.toMatchObject({ code: 'invalid-hash' });
    }
    await expect(store.get(A, 999 as never)).rejects.toBeInstanceOf(ThumbStoreError);
    await expect(store.put(A, 1 as never, webp(20))).rejects.toMatchObject({ code: 'invalid-size' });
    expect(await entries(await thumbsDir(root))).toEqual([]);
  });

  test('something that is not a complete image is never stored', async () => {
    const root = createMemoryDirectory();
    const store = await openThumbStore(root);
    await expect(store.put(A, 320, new Blob(['<script>alert(1)</script>']))).rejects.toMatchObject({ code: 'invalid-thumbnail' });
    await expect(store.put(A, 320, new Blob([]))).rejects.toMatchObject({ code: 'invalid-thumbnail' });
    expect(await entries(await thumbsDir(root))).toEqual([]);
  });

  test('list gives each photo with a thumbnail once, sorted, and ignores other files', async () => {
    const root = createMemoryDirectory();
    const store = await openThumbStore(root);
    expect(await store.list()).toEqual([]);
    await store.put(B, 320, webp(40));
    await store.put(A, 320, webp(40));
    await (await root.getDirectoryHandle(THUMBS_DIRECTORY)).getFileHandle('notes.txt', { create: true });
    expect(await store.list()).toEqual([A, B]);
    await store.delete(A);
    expect(await store.list()).toEqual([B]);
  });

  test('delete drops the photo thumbnails and nothing else; clear drops all', async () => {
    const root = createMemoryDirectory();
    const store = await openThumbStore(root);
    await store.put(A, 320, webp(40));
    await store.put(B, 320, webp(40));
    await store.delete(A);
    await store.delete(C); // absent: fine
    expect(await store.get(A, 320)).toBeUndefined();
    expect(await store.get(B, 320)).toBeDefined();
    expect(await store.usage()).toEqual({ count: 1, bytes: 40 });
    await store.clear();
    expect(await store.get(B, 320)).toBeUndefined();
    expect(await store.usage()).toEqual({ count: 0, bytes: 0 });
    expect(await entries(await thumbsDir(root))).toEqual([]);
  });

  test('over the cap the least recently used are evicted, never the one just written', async () => {
    let clock = 0;
    const store = await openThumbStore(createMemoryDirectory(), { maxBytes: 250, now: () => ++clock });
    await store.put(A, 320, webp(100));
    await store.put(B, 320, webp(100));
    await store.get(A, 320); // A is now more recent than B
    await store.put(C, 320, webp(100));
    expect(await store.get(B, 320)).toBeUndefined();
    expect(await store.get(A, 320)).toBeDefined();
    expect(await store.get(C, 320)).toBeDefined();
    expect((await store.usage()).bytes).toBeLessThanOrEqual(250);
  });

  test('a single thumbnail larger than the cap is not stored', async () => {
    const store = await openThumbStore(createMemoryDirectory(), { maxBytes: 50 });
    await store.put(A, 320, webp(100));
    expect(await store.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test('the size index is rebuilt from the directory on reopen, oldest files evicted first', async () => {
    const root = createMemoryDirectory();
    const first = await openThumbStore(root);
    await first.put(A, 320, webp(100));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.put(B, 320, webp(100));
    const second = await openThumbStore(root, { maxBytes: 250 });
    expect(await second.usage()).toEqual({ count: 2, bytes: 200 });
    await second.put(C, 320, webp(100));
    expect(await second.get(A, 320)).toBeUndefined();
    expect(await second.get(B, 320)).toBeDefined();
  });

  test('a truncated or damaged file is a miss and is removed, never served', async () => {
    const root = createMemoryDirectory();
    const store = await openThumbStore(root);
    await store.put(A, 320, webp(100));
    const dir = await thumbsDir(root);
    const file = await dir.getFileHandle(`${A}-320`);
    const writable = await file.createWritable!();
    await writable.write(new Uint8Array(await (await file.getFile()).arrayBuffer()).subarray(0, 60));
    await writable.close();
    expect(await store.get(A, 320)).toBeUndefined();
    expect(await entries(dir)).toEqual([]);
  });

  test('a failed write leaves no temp file and no entry, and the cache stays usable', async () => {
    const root = createMemoryDirectory();
    const dir = await root.getDirectoryHandle(THUMBS_DIRECTORY, { create: true });
    let broken = true;
    const wrapped: OpfsDirectoryHandle = {
      kind: 'directory',
      name: dir.name,
      getDirectoryHandle: dir.getDirectoryHandle.bind(dir),
      removeEntry: dir.removeEntry.bind(dir),
      entries: dir.entries.bind(dir),
      async getFileHandle(name, options) {
        const handle = await dir.getFileHandle(name, options);
        if (!broken) return handle;
        const failingWrite = async () => ({ write: async () => { throw new Error('disk full'); }, close: async () => {}, abort: async () => {} });
        return { kind: 'file', name: handle.name, getFile: handle.getFile.bind(handle), createWritable: failingWrite };
      },
    };
    const failing: OpfsDirectoryHandle = { ...root, getDirectoryHandle: async () => wrapped };
    const store = await openThumbStore(failing);
    await expect(store.put(A, 320, webp(100))).rejects.toThrow('disk full');
    expect(await entries(dir)).toEqual([]);
    expect(await store.get(A, 320)).toBeUndefined();
    broken = false;
    const again = await openThumbStore(root);
    await again.put(A, 320, webp(100));
    expect(await again.get(A, 320)).toBeDefined();
  });

  test('without move() the file is still only served complete', async () => {
    const store = await openThumbStore(createMemoryDirectory({ move: false }));
    await store.put(A, 320, webp(100));
    expect((await store.get(A, 320))?.size).toBe(100);
    expect(await store.usage()).toEqual({ count: 1, bytes: 100 });
  });

  test('temp files from an interrupted write are swept on open; unknown files are not counted', async () => {
    const root = createMemoryDirectory();
    const dir = await root.getDirectoryHandle(THUMBS_DIRECTORY, { create: true });
    await dir.getFileHandle('tmp-1234', { create: true });
    await dir.getFileHandle('notes.txt', { create: true });
    const store = await openThumbStore(root);
    expect(await entries(dir)).toEqual(['notes.txt']);
    expect(await store.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test('lives apart from the blobs: the blob store neither lists nor touches it', async () => {
    const root = createMemoryDirectory();
    const blobs = await openBlobStore(root);
    const store = await openThumbStore(root);
    const { sha256 } = await blobs.put(new Uint8Array([1, 2, 3]));
    await store.put(sha256, 320, webp(40));
    expect(await blobs.list()).toEqual([sha256]);
    expect(await entries(await root.getDirectoryHandle(BLOBS_DIRECTORY))).not.toContain(`${sha256}-320`);
    await blobs.delete(sha256);
    expect(await store.get(sha256, 320)).toBeDefined(); // deleting a blob is a use case's job (see import undo)
  });

  test('completeImageType recognises complete webp and jpeg only', async () => {
    expect(completeImageType(new Uint8Array(await webp(30).arrayBuffer()))).toBe('image/webp');
    expect(completeImageType(new Uint8Array(await jpeg(10).arrayBuffer()))).toBe('image/jpeg');
    expect(completeImageType(new Uint8Array(await webp(30).arrayBuffer()).subarray(0, 29))).toBeUndefined();
    expect(completeImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});
