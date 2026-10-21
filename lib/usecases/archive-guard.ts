import { ArchiveError } from '../exporters/archive/format';
import type { BlobStore } from '../storage/blob-store';

/**
 * A cross-tab mutual exclusion, injected so `lib/` stays platform-neutral. It must try to take
 * the named lock WITHOUT waiting and run `work` only if it got it: `{ held: false }` means
 * another tab holds it. The app's implementation is `webArchiveLock` (Web Locks).
 */
export type ArchiveLock = <T>(name: string, work: () => Promise<T>) => Promise<{ held: true; value: T } | { held: false }>;

export const ARCHIVE_LOCK_NAME = 'memory-archive';

/** `navigator.locks` as an `ArchiveLock` (`ifAvailable`: never waits). Only call where `navigator.locks` exists. */
export const webArchiveLock: ArchiveLock = (name, work) =>
  navigator.locks.request(name, { ifAvailable: true }, async (lock) =>
    lock === null ? ({ held: false } as const) : ({ held: true, value: await work() } as const),
  );

/**
 * The archive busy guard: ONE archive-level operation at a time per library, in this thread
 * (export, restore, import, undo, orphan sweep). A second one is refused with `busy`: two
 * restores would interleave their blob writes and cleanups, and a sweep or a restore's
 * "clear leftovers" step would delete the blobs an import has written but not yet committed.
 * The flag is set before the first `await`, released in `finally`.
 *
 * Keyed by the blob store: it is the one object every operation shares, whether it holds the
 * database directly (backup, restore) or reaches it through the worker client (import).
 */
const running = new WeakSet<object>();

export async function withArchiveGuard<T>(blobStore: BlobStore, work: () => Promise<T>, lock?: ArchiveLock): Promise<T> {
  if (running.has(blobStore)) throw new ArchiveError('busy', 'another archive operation is already running');
  running.add(blobStore);
  try {
    if (!lock) return await work();
    const outcome = await lock(ARCHIVE_LOCK_NAME, work);
    if (!outcome.held) throw new ArchiveError('busy', 'another tab is running an archive operation');
    return outcome.value;
  } finally {
    running.delete(blobStore);
  }
}
