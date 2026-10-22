import type { StorageBreakdown } from '../db/queries';
import type { LibraryDeps } from './profiles';
import { readStorageStatus, requestPersistentStorage, type StorageStatus } from '../storage/quota';
import { listSharedFiles, readSharedFile, removeSharedFile, type SharedFileInfo } from '../storage/share-inbox';

export type { SharedFileInfo, StorageBreakdown, StorageStatus };

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

/** The Settings bar: bytes of "photos and videos" against "messages and audio". */
export interface ArchiveSizes extends StorageBreakdown {
  /** Photos and videos. */
  photosVideos: number;
  /** Messages (the database) plus audio and every other stored file. */
  messagesAndAudio: number;
}

/**
 * What the archive itself stores, split for Settings. Exact for stored media (sizes recorded
 * per file) and for the database (logical size); it does NOT include the thumbnail cache, the
 * app's own files or browser overhead, which is why the sum can be below `StorageStatus.usage`.
 */
export async function getArchiveSizes(deps: LibraryDeps): Promise<ArchiveSizes> {
  const b = await deps.client.call('getStorageBreakdown');
  return { ...b, photosVideos: b.photosVideosBytes, messagesAndAudio: b.databaseBytes + b.otherMediaBytes };
}
