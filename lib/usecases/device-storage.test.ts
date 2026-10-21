import { describe, expect, test } from 'vitest';
import { storeSharedFiles } from '../storage/share-inbox';
import { createMemoryCacheStorage } from '../storage/test-cache-storage';
import { discardSharedFile, getDeviceStorageStatus, getSharedFiles, prepareDeviceStorage, takeSharedFile } from './device-storage';

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

  test('takeSharedFile reads a shared file back, discardSharedFile forgets it', async () => {
    const caches = createMemoryCacheStorage();
    await storeSharedFiles(caches, 'https://x.example/', [new File(['zip bytes'], 'c.zip', { type: 'application/zip' })]);
    const [info] = await getSharedFiles(caches);

    const file = await takeSharedFile(info, caches);
    expect(file?.name).toBe('c.zip');
    expect(file?.size).toBe(9);

    expect(await discardSharedFile(info.key, caches)).toBe(true);
    expect(await getSharedFiles(caches)).toEqual([]);
    expect(await takeSharedFile(info, caches)).toBeUndefined();
    expect(await discardSharedFile(info.key, caches)).toBe(false);
  });

  test('without Cache Storage nothing is read or discarded', async () => {
    const info = { key: 'k', name: 'c.zip', type: 'application/zip', size: 1, receivedAt: 0 };
    expect(await takeSharedFile(info, undefined)).toBeUndefined();
    expect(await discardSharedFile('k', undefined)).toBe(false);
  });
});
