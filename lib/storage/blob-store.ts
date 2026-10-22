/**
 * Content-addressed blob store: media bytes are stored under the SHA-256 of their
 * content, so the same photo imported twice is stored once. The database keeps only
 * the hash (`blobs.sha256`); this module owns the bytes.
 *
 * Contract every implementation keeps:
 * - Only 64 lowercase hex strings are ever turned into storage names (anything else
 *   throws `invalid-hash`), so a name coming from a ZIP or a backup can never become a path.
 * - `put` is idempotent and streams: the hash is computed while the bytes are written
 *   to a temporary name, and the blob appears under its hash only once complete.
 *   A failed or aborted write leaves nothing visible.
 */

export type BlobSource = Uint8Array | ReadableStream<Uint8Array>;

export interface BlobInfo {
  sha256: string;
  size: number;
}

/** `missing`: no such blob. `corrupt`: bytes no longer hash to the name. */
export type BlobVerification = 'ok' | 'missing' | 'corrupt';

export interface BlobStore {
  /** Store the bytes under their SHA-256. Storing the same content again changes nothing. */
  put(source: BlobSource): Promise<BlobInfo>;
  has(sha256: string): Promise<boolean>;
  /** The blob as a stream, or `undefined` when absent. */
  open(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Size in bytes, or `undefined` when absent. */
  size(sha256: string): Promise<number | undefined>;
  /** Returns whether a blob was removed. */
  delete(sha256: string): Promise<boolean>;
  /** Every stored hash, sorted. */
  list(): Promise<string[]>;
  /** Rehash the stored bytes and compare with the name. */
  verify(sha256: string): Promise<BlobVerification>;
  /**
   * Stores that keep temp files for writes in progress: delete the abandoned ones. Only safe
   * while NO other writer is active (see `sweepLeftovers`, which proves it with the archive lock).
   */
  sweepTemp?(): Promise<void>;
}

export type BlobStoreErrorCode = 'invalid-hash' | 'invalid-source' | 'unsupported' | 'io';

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  constructor(code: BlobStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlobStoreError';
    this.code = code;
  }
}
