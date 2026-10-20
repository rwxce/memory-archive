import { describe, expect, test } from 'vitest';
import { storeSharedFiles } from '../storage/share-inbox';
import { createMemoryCacheStorage } from '../storage/test-cache-storage';
import { getDeviceStorageStatus, getSharedFiles, prepareDeviceStorage } from './device-storage';

const fakeStorage = (persisted: boolean) =>
  ({
    persisted: async () => persisted,
    persist: async () => true,
    estimate: async () => ({ usage: 10, quota: 100 }),
  }) as unknown as StorageManager;

describe('device storage use cases', () => {
  test('prepareDeviceStorage asks for persistence', async () => {
    expect(await prepareDeviceStorage(fakeStorage(false))).toBe(true);
    expect(await prepareDeviceStorage(undefined)).toBeNull();
  });

  test('getDeviceStorageStatus', async () => {
    expect(await getDeviceStorageStatus(fakeStorage(true))).toEqual({ usage: 10, quota: 100, persisted: true });
  });

  test('getSharedFiles lists the share inbox, empty without Cache Storage', async () => {
    const caches = createMemoryCacheStorage();
    await storeSharedFiles(caches, 'https://x.example/', [new File(['z'], 'c.zip', { type: 'application/zip' })]);
    expect((await getSharedFiles(caches)).map((f) => f.name)).toEqual(['c.zip']);
    expect(await getSharedFiles(undefined)).toEqual([]);
  });
});
