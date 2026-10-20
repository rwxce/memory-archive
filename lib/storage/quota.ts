/**
 * Browser storage quota and persistence (`navigator.storage`). Persistent
 * storage asks the browser not to evict this origin's data (OPFS, caches)
 * under storage pressure — essential for an archive that only lives here.
 */

export interface StorageStatus {
  /** Bytes used by this app on this device, when the browser reports it. */
  usage: number | null;
  /** Bytes this app may use (an estimate, often much less than the free disk). */
  quota: number | null;
  /** Whether the browser promised not to clear the data on its own. */
  persisted: boolean | null;
}

type StorageLike = Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>;

/**
 * Ask for persistent storage. Browsers decide on their own (Chrome grants it
 * to installed or engaged sites, Safari to home-screen apps, Firefox asks the
 * person). Returns the resulting state, or null when unsupported.
 */
export async function requestPersistentStorage(storage: Partial<StorageLike> | undefined): Promise<boolean | null> {
  if (!storage?.persist) return null;
  try {
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}

/** Current usage, quota and persistence; unknown parts are null. */
export async function readStorageStatus(storage: Partial<StorageLike> | undefined): Promise<StorageStatus> {
  const status: StorageStatus = { usage: null, quota: null, persisted: null };
  if (!storage) return status;
  try {
    if (storage.estimate) {
      const est = await storage.estimate();
      status.usage = typeof est.usage === 'number' ? est.usage : null;
      status.quota = typeof est.quota === 'number' ? est.quota : null;
    }
  } catch {
    // estimate() can throw in some private modes: leave unknown.
  }
  try {
    if (storage.persisted) status.persisted = await storage.persisted();
  } catch {
    // leave unknown
  }
  return status;
}
