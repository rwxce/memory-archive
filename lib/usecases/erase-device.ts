import { OPFS_DIRECTORY } from '../db/opfs-names';
import { createLogger } from '../log';
import { BLOBS_DIRECTORY, isNotFound, type OpfsDirectoryHandle } from '../storage/opfs-blob-store';
import { THUMBS_DIRECTORY } from '../storage/opfs-thumb-store';
import { SHARE_INBOX_CACHE } from '../storage/share-inbox';
import type { Library } from './library';

const log = createLogger('erase-device');

/** Prefix of every key the app writes to localStorage / sessionStorage (theme, reading position). */
export const APP_STORAGE_PREFIX = 'memory-archive:';

/** What was erased, in the order it is attempted. */
export type EraseTarget = 'database' | 'media' | 'thumbnails' | 'share-inbox' | 'preferences';

export interface EraseDeviceResult {
  /** Everything was erased (or was already absent). */
  complete: boolean;
  /** Targets that could not be erased; the UI should offer to try again. Never contains text or names. */
  failed: EraseTarget[];
}

export interface EraseDeviceDeps {
  /** The open library, if any: its database worker is stopped first so OPFS files can be removed. */
  library?: Pick<Library, 'close'>;
  /** `navigator.storage.getDirectory()`; `undefined` where OPFS does not exist (nothing to erase there). */
  root?: OpfsDirectoryHandle;
  cacheStorage?: CacheStorage;
  localStorage?: Pick<Storage, 'length' | 'key' | 'removeItem'>;
  sessionStorage?: Pick<Storage, 'length' | 'key' | 'removeItem'>;
  /** Wait between retries of a directory the closing worker still holds (default 100 ms). */
  retryDelayMs?: number;
}

const OPFS_ATTEMPTS = 4;

/**
 * "Erase everything on this device": stops the database worker, removes the three OPFS
 * directories (database + search index, media, thumbnails), the share-inbox cache and the app's
 * localStorage / sessionStorage keys. The service worker and its precache are NOT touched, so the
 * app keeps opening offline. A missing directory or cache counts as erased. Each target is tried
 * even when another fails; it never throws, so the UI reports from the result. Idempotent.
 *
 * UI: `await eraseDevice({ library, root: await navigator.storage.getDirectory(), cacheStorage: caches,
 * localStorage, sessionStorage })` after an explicit confirmation, then reload the app.
 */
export async function eraseDevice(deps: EraseDeviceDeps): Promise<EraseDeviceResult> {
  const failed: EraseTarget[] = [];
  const attempt = async (target: EraseTarget, work: () => Promise<void> | void) => {
    try {
      await work();
    } catch (error) {
      log.warn(`could not erase ${target}`, error instanceof Error ? error.name : 'error');
      failed.push(target);
    }
  };

  // Stopping the worker releases the sync access handles on the database files; without that the
  // directory cannot be removed. A failure here is not fatal: removal below reports what is left.
  try {
    deps.library?.close({ force: true });
  } catch {
    // already closed
  }

  const dbDirectory = OPFS_DIRECTORY.replace(/^\/+/, '');
  const { root } = deps;
  await attempt('database', () => removeDirectory(root, dbDirectory, deps.retryDelayMs ?? 100));
  await attempt('media', () => removeDirectory(root, BLOBS_DIRECTORY, deps.retryDelayMs ?? 100));
  await attempt('thumbnails', () => removeDirectory(root, THUMBS_DIRECTORY, deps.retryDelayMs ?? 100));
  await attempt('share-inbox', async () => {
    await deps.cacheStorage?.delete(SHARE_INBOX_CACHE);
  });
  await attempt('preferences', () => {
    removePrefixed(deps.localStorage);
    removePrefixed(deps.sessionStorage);
  });

  return { complete: failed.length === 0, failed };
}

async function removeDirectory(root: OpfsDirectoryHandle | undefined, name: string, retryDelayMs: number): Promise<void> {
  if (!root) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await root.removeEntry(name, { recursive: true });
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (attempt >= OPFS_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function removePrefixed(storage: EraseDeviceDeps['localStorage']): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(APP_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
