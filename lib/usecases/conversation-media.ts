import { isSha256Hex } from '../domain/library';
import type { BlobStore } from '../storage/blob-store';

/**
 * Size in bytes of a stored file, without reading it (for a file chip). `undefined` when the
 * store does not have it or the hash is malformed: the view shows its "missing file" state.
 */
export async function blobSize(deps: { blobStore: BlobStore }, sha256: string): Promise<number | undefined> {
  if (!isSha256Hex(sha256)) return undefined;
  return deps.blobStore.size(sha256);
}
