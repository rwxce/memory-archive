import type { BlobStore } from '../storage/blob-store';
import { makeThumbnail } from '../storage/thumbnail';
import type { ThumbSize, ThumbStore } from '../storage/thumb-store';
import { DbError } from '../db/errors';
import { isSha256Hex } from '../domain/library';
import { readBlob } from './conversation-view';

/** The thumbnail a gallery tile shows: longest side, in pixels. */
export const TILE_THUMB_SIZE: ThumbSize = 320;

/** A photo this small is cheaper to show as it is than to thumbnail and cache. */
export const THUMB_MIN_SOURCE_BYTES = 32 * 1024;

/** A photo larger than this is shown as it is: decoding it just for a thumbnail could exhaust memory. */
export const THUMB_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * The picture for one gallery tile: the cached thumbnail when there is one; else the photo is read,
 * thumbnailed and the thumbnail cached for next time. The full file is what comes back when no
 * thumbnail can be made (small file, undecodable format, browser without the APIs) and it is
 * always what the lightbox uses. A thumbnail is only ever served for a photo that is still stored (a
 * deleted photo is `not-found` even if its thumbnail lingers), and one written while its photo was
 * being deleted is removed again. The cache is only ever an optimisation: a cache that cannot be read
 * or written is ignored. `not-found` / `invalid` from the blob store propagate as for any media.
 */
export async function readTileImage(
  deps: { blobStore: BlobStore; thumbStore?: ThumbStore },
  source: { sha256: string; mime?: string | null; name?: string },
  make: (blob: Blob, maxSide: number) => Promise<Blob | undefined> = makeThumbnail,
): Promise<Blob> {
  if (isSha256Hex(source.sha256) && !(await deps.blobStore.has(source.sha256))) {
    await deps.thumbStore?.delete(source.sha256).catch(() => undefined);
    throw new DbError('not-found', 'media is not in the blob store');
  }
  const cached = await deps.thumbStore?.get(source.sha256, TILE_THUMB_SIZE).catch(() => undefined);
  if (cached) return cached;
  const full = await readBlob(deps, source.sha256, source);
  if (full.size < THUMB_MIN_SOURCE_BYTES || full.size > THUMB_MAX_SOURCE_BYTES) return full;
  const thumbnail = await make(full, TILE_THUMB_SIZE);
  if (!thumbnail) return full;
  if (!deps.thumbStore) return thumbnail;
  await deps.thumbStore.put(source.sha256, TILE_THUMB_SIZE, thumbnail).catch(() => undefined);
  if (!(await deps.blobStore.has(source.sha256))) {
    // The photo was deleted while its thumbnail was being made: leave nothing of it behind.
    await deps.thumbStore.delete(source.sha256).catch(() => undefined);
    throw new DbError('not-found', 'media is not in the blob store');
  }
  return thumbnail;
}
