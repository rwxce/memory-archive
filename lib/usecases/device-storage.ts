import { readStorageStatus, requestPersistentStorage, type StorageStatus } from '../storage/quota';
import { listSharedFiles, readSharedFile, removeSharedFile, type SharedFileInfo } from '../storage/share-inbox';

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

/** One shared file read back as a `File` (for the import wizard); `undefined` when it is gone. */
export async function takeSharedFile(
  info: SharedFileInfo,
  cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<File | undefined> {
  if (!cacheStorage) return undefined;
  return readSharedFile(cacheStorage, info);
}

/** Forget a shared file (it was imported, or the person does not want it). Never throws for a missing one. */
export async function discardSharedFile(
  key: string,
  cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<boolean> {
  if (!cacheStorage) return false;
  return removeSharedFile(cacheStorage, key);
}
