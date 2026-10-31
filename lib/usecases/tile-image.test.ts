import { describe, expect, test, vi } from 'vitest';
import { webpBlob } from '../storage/test-thumbnail';
import { createTestLibrary } from './test-client';
import { readTileImage, readTileThumbnail, THUMB_MIN_SOURCE_BYTES, TILE_THUMB_SIZE } from './tile-image';

async function setup(size = THUMB_MIN_SOURCE_BYTES + 1) {
  const lib = await createTestLibrary();
  const { sha256 } = await lib.deps.blobStore.put(new Uint8Array(size).fill(9));
  return { lib, sha256 };
}
const thumb = () => webpBlob(40);

describe('readTileImage', () => {
  test('a miss reads the photo, makes the thumbnail, caches it and returns it; the next call never reads the photo', async () => {
    const { lib, sha256 } = await setup();
    const make = vi.fn(async (_blob: Blob, _maxSide: number): Promise<Blob | undefined> => thumb());
    const first = await readTileImage(lib.deps, { sha256, mime: 'image/jpeg' }, make);
    expect(first.size).toBe(40);
    expect(make).toHaveBeenCalledTimes(1);
    expect(make.mock.calls[0]![0].size).toBe(THUMB_MIN_SOURCE_BYTES + 1);
    expect(make.mock.calls[0]![1]).toBe(TILE_THUMB_SIZE);
    expect((await lib.deps.thumbStore!.get(sha256, TILE_THUMB_SIZE))?.size).toBe(40);

    const second = await readTileImage(lib.deps, { sha256 }, make);
    expect(second.size).toBe(40);
    expect(make).toHaveBeenCalledTimes(1);
  });

  test('a cached thumbnail is never served once its photo is gone, and it is dropped', async () => {
    const { lib, sha256 } = await setup();
    await readTileImage(lib.deps, { sha256 }, async () => thumb());
    await lib.deps.blobStore.delete(sha256);
    await expect(readTileImage(lib.deps, { sha256 }, async () => thumb())).rejects.toMatchObject({ code: 'not-found' });
    expect(await lib.deps.thumbStore!.get(sha256, TILE_THUMB_SIZE)).toBeUndefined();
  });

  test('a photo deleted while its thumbnail is being made leaves no thumbnail behind', async () => {
    const { lib, sha256 } = await setup();
    const make = async () => {
      await lib.deps.blobStore.delete(sha256);
      return thumb();
    };
    await expect(readTileImage(lib.deps, { sha256 }, make)).rejects.toMatchObject({ code: 'not-found' });
    expect(await lib.deps.thumbStore!.list()).toEqual([]);
  });

  test('no thumbnail possible (undecodable format, no browser support): the full file, nothing cached', async () => {
    const { lib, sha256 } = await setup();
    const full = await readTileImage(lib.deps, { sha256, mime: 'image/heic' }, async () => undefined);
    expect(full.size).toBe(THUMB_MIN_SOURCE_BYTES + 1);
    expect(full.type).toBe('image/heic');
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 0, bytes: 0 });
  });

  test('readTileThumbnail: no thumbnail possible (or a photo over the decode limit) is undefined, never the full file', async () => {
    const { lib, sha256 } = await setup();
    expect(await readTileThumbnail(lib.deps, { sha256, mime: 'image/heic' }, async () => undefined)).toBeUndefined();
    expect(await lib.deps.thumbStore!.usage()).toEqual({ count: 0, bytes: 0 });
    expect((await readTileThumbnail(lib.deps, { sha256 }, async () => thumb()))!.size).toBe(40);
    // Cached now: served without decoding again.
    expect((await readTileThumbnail(lib.deps, { sha256 }, async () => undefined))!.size).toBe(40);
    const small = await setup(THUMB_MIN_SOURCE_BYTES - 1);
    expect((await readTileThumbnail(small.lib.deps, { sha256: small.sha256 }, async () => undefined))!.size).toBe(THUMB_MIN_SOURCE_BYTES - 1);
  });

  test('a small photo is shown as it is, without trying', async () => {
    const { lib, sha256 } = await setup(THUMB_MIN_SOURCE_BYTES - 1);
    const make = vi.fn(async () => thumb());
    expect((await readTileImage(lib.deps, { sha256 }, make)).size).toBe(THUMB_MIN_SOURCE_BYTES - 1);
    expect(make).not.toHaveBeenCalled();
  });

  test('a cache that fails to read or write is ignored', async () => {
    const { lib, sha256 } = await setup();
    const thumbStore = { ...lib.deps.thumbStore!, get: async () => Promise.reject(new Error('io')), put: async () => Promise.reject(new Error('io')) };
    const result = await readTileImage({ ...lib.deps, thumbStore }, { sha256 }, async () => thumb());
    expect(result.size).toBe(40);
  });

  test('works without a cache at all', async () => {
    const { lib, sha256 } = await setup();
    const result = await readTileImage({ blobStore: lib.deps.blobStore }, { sha256 }, async () => thumb());
    expect(result.size).toBe(40);
  });

  test('a missing blob is not-found; a bad hash is invalid', async () => {
    const { lib } = await setup();
    await expect(readTileImage(lib.deps, { sha256: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'not-found' });
    await expect(readTileImage(lib.deps, { sha256: '../x' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
