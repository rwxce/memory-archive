import { describe, expect, test } from 'vitest';
import { storeSharedFiles } from '../storage/share-inbox';
import { createMemoryCacheStorage } from '../storage/test-cache-storage';
import type { NewMessage } from '../domain/library';
import { createTestLibrary } from './test-client';
import { discardSharedFile, getArchiveSizes, getDeviceStorageStatus, getSharedFiles, prepareDeviceStorage, takeSharedFile } from './device-storage';

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

describe('getArchiveSizes', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const hash = (c: string) => c.repeat(64);
  const msg = (n: number, type: NewMessage['type'], sha: string | null): NewMessage => ({
    fingerprint: n.toString(16).padStart(64, '0'),
    sentAt: `2026-01-01T10:0${n}:00`,
    ordinal: 0,
    type,
    participantName: 'Ana',
    body: '',
    mediaSha256: sha,
    mediaName: sha ? `f${n}` : '',
  });

  test('an empty library has no media and only the database size', async () => {
    const lib = await createTestLibrary();
    const sizes = await getArchiveSizes(lib.deps);
    expect(sizes.photosVideos).toBe(0);
    expect(sizes.otherMediaBytes).toBe(0);
    expect(sizes.databaseBytes).toBeGreaterThan(0);
    expect(sizes.messagesAndAudio).toBe(sizes.databaseBytes);
  });

  test('splits photos and videos from audio and other files; a shared file counts once', async () => {
    const lib = await createTestLibrary();
    await lib.client.call('importMessages', {
      batchId: uuid(100),
      conversationId: uuid(10),
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: '2026-02-01T12:00:00Z',
      blobs: [
        { sha256: hash('a'), size: 1000, mime: 'image/jpeg' },
        { sha256: hash('b'), size: 5000, mime: 'video/mp4' },
        { sha256: hash('c'), size: 300, mime: 'audio/ogg' },
        { sha256: hash('d'), size: 20, mime: null },
      ],
      messages: [
        msg(1, 'photo', hash('a')),
        msg(2, 'photo', hash('a')),
        msg(3, 'video', hash('b')),
        msg(4, 'audio', hash('c')),
        msg(5, 'document', hash('d')),
        msg(6, 'text', null),
      ],
      newConversation: { title: 'Chat', sourceKey: 'chat', isGroup: false, profileIds: [] },
      meAuthor: null,
    });
    const sizes = await getArchiveSizes(lib.deps);
    expect(sizes.photosVideos).toBe(6000);
    expect(sizes.otherMediaBytes).toBe(320);
    expect(sizes.messagesAndAudio).toBe(sizes.databaseBytes + 320);
  });
});
