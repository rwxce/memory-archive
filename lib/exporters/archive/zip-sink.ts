import { Zip } from 'fflate';
import { ArchiveError } from './format';

/** Produced bytes are folded into a `Blob` (which the browser may keep outside the JS heap) this often. */
const FLUSH_BYTES = 16 * 1024 * 1024;

/**
 * The output side shared by the archive and viewer-package writers: an fflate streaming `Zip` whose
 * chunks are folded into sub-`Blob`s every ~16 MB, so the JS heap holds at most that much while the
 * browser keeps the rest outside it. `check()` rethrows an error fflate reported from a callback.
 */
export function createZipSink(): { zip: Zip; check(): void; finish(): Blob } {
  const folded: Blob[] = [];
  let parts: Uint8Array[] = [];
  let pending = 0;
  let failure: unknown;
  const zip = new Zip((error, chunk) => {
    if (error) {
      failure = error;
      return;
    }
    parts.push(chunk);
    pending += chunk.length;
    if (pending >= FLUSH_BYTES) {
      folded.push(new Blob(parts as BlobPart[]));
      parts = [];
      pending = 0;
    }
  });
  const check = () => {
    if (failure) throw new ArchiveError('storage', 'could not assemble the archive', { cause: failure });
  };
  return {
    zip,
    check,
    finish() {
      zip.end();
      check();
      return new Blob([...folded, ...(parts as BlobPart[])], { type: 'application/zip' });
    },
  };
}
