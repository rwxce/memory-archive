/**
 * Thumbnail cache: small pictures derived from stored photos so a grid never has to read and
 * decode the full-size files. It is a DERIVED cache, never a source of truth:
 * - losing any part of it (or all of it) only costs a regeneration the next time a tile is shown;
 * - it is not part of a backup or sync ZIP, and a restore starts with an empty one;
 * - only 64 lowercase hex hashes and a known size tag ever become file names;
 * - it is bounded: a `put` that pushes the total over the cap evicts the least recently used.
 */

/** The size tags that exist: the longest side, in pixels, of a thumbnail. One today (the gallery tile). */
export const THUMB_SIZES = [320] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

export const isThumbSize = (value: unknown): value is ThumbSize => THUMB_SIZES.includes(value as ThumbSize);

export interface ThumbUsage {
  count: number;
  bytes: number;
}

export interface ThumbStore {
  /** The cached thumbnail, or `undefined` on a miss (also for one found damaged: it is dropped). */
  get(sha256: string, size: ThumbSize): Promise<Blob | undefined>;
  /** Stores (or replaces) a thumbnail of the photo `sha256`; may evict older ones to stay under the cap. */
  put(sha256: string, size: ThumbSize, thumbnail: Blob): Promise<void>;
  /** Drops every size of one photo's thumbnails (its blob was deleted). */
  delete(sha256: string): Promise<void>;
  /** Drops the whole cache. */
  clear(): Promise<void>;
  /** The photos that have at least one thumbnail, sorted. */
  list(): Promise<string[]>;
  usage(): Promise<ThumbUsage>;
}

export type ThumbStoreErrorCode = 'invalid-hash' | 'invalid-size' | 'invalid-thumbnail' | 'unsupported';

export class ThumbStoreError extends Error {
  readonly code: ThumbStoreErrorCode;
  constructor(code: ThumbStoreErrorCode, message: string) {
    super(message);
    this.name = 'ThumbStoreError';
    this.code = code;
  }
}
