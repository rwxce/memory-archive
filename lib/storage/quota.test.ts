import { describe, expect, test, vi } from 'vitest';
import { readStorageStatus, requestPersistentStorage } from './quota';

describe('storage quota', () => {
  test('requestPersistentStorage: already persisted, granted, refused, unsupported, throwing', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persisted: async () => true, persist })).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    expect(await requestPersistentStorage({ persisted: async () => false, persist })).toBe(true);
    expect(persist).toHaveBeenCalledOnce();

    expect(await requestPersistentStorage({ persist: async () => false })).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBeNull();
    expect(await requestPersistentStorage({})).toBeNull();
    expect(
      await requestPersistentStorage({
        persist: async () => {
          throw new Error('denied');
        },
      }),
    ).toBeNull();
  });

  test('readStorageStatus: reports what the browser knows, null for the rest', async () => {
    expect(
      await readStorageStatus({
        estimate: async () => ({ usage: 1234, quota: 10_000 }),
        persisted: async () => false,
      }),
    ).toEqual({ usage: 1234, quota: 10_000, persisted: false });
    expect(await readStorageStatus(undefined)).toEqual({ usage: null, quota: null, persisted: null });
    expect(
      await readStorageStatus({
        estimate: async () => {
          throw new Error('private mode');
        },
      }),
    ).toEqual({ usage: null, quota: null, persisted: null });
  });
});
