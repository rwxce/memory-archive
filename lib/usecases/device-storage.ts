import { readStorageStatus, requestPersistentStorage, type StorageStatus } from '../storage/quota';
import { listSharedFiles, type SharedFileInfo } from '../storage/share-inbox';

export type { SharedFileInfo, StorageStatus };

/**
 * First "Start": ask the browser to keep this device's archive even when space
 * runs low. Safe to call again; returns whether storage is now persistent
 * (null when the browser does not support asking).
 */
export function prepareDeviceStorage(storage: StorageManager | undefined = globalThis.navigator?.storage) {
  return requestPersistentStorage(storage);
}

/** Space used / available on this device, for Settings. */
export function getDeviceStorageStatus(
  storage: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<StorageStatus> {
  return readStorageStatus(storage);
}

/** Files shared to the app (Web Share Target) that are waiting to be imported. */
export async function getSharedFiles(
  cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<SharedFileInfo[]> {
  if (!cacheStorage) return [];
  return listSharedFiles(cacheStorage);
}
