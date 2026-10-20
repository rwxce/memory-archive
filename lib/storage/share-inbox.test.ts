import { describe, expect, test } from 'vitest';
import {
  isAcceptedSharedFile,
  listSharedFiles,
  MAX_SHARED_FILES,
  readSharedFile,
  removeSharedFile,
  SHARE_INBOX_PATH,
  storeSharedFiles,
} from './share-inbox';
import { createMemoryCacheStorage } from './test-cache-storage';

const SCOPE = 'https://app.example/memory-archive/';
const zip = (name = 'WhatsApp Chat - Synthetic.zip') => new File([new Uint8Array([0x50, 0x4b, 3, 4])], name, { type: 'application/zip' });

describe('share inbox', () => {
  test('accepts ZIP and plain text, by type or by extension when the type is missing', () => {
    expect(isAcceptedSharedFile({ name: 'a.zip', type: 'application/zip' })).toBe(true);
    expect(isAcceptedSharedFile({ name: '_chat.txt', type: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isAcceptedSharedFile({ name: 'chat.zip', type: '' })).toBe(true);
    expect(isAcceptedSharedFile({ name: 'chat.ZIP', type: 'application/octet-stream' })).toBe(true);
    expect(isAcceptedSharedFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isAcceptedSharedFile({ name: 'evil.zip', type: 'text/html' })).toBe(false);
    expect(isAcceptedSharedFile({ name: 'noext', type: '' })).toBe(false);
  });

  test('stores accepted files under the app scope and lists them back', async () => {
    const caches = createMemoryCacheStorage();
    const txt = new File(['01/01/2026 10:00 - A: hi\n'], 'Ñandú 😀.txt', { type: 'text/plain' });
    const stored = await storeSharedFiles(caches, SCOPE, [zip(), txt, new File(['x'], 'p.jpg', { type: 'image/jpeg' })], 1000);
    expect(stored).toBe(2);

    const list = await listSharedFiles(caches);
    expect(list.map((f) => [f.name, f.size, f.receivedAt])).toEqual([
      ['WhatsApp Chat - Synthetic.zip', 4, 1000],
      ['Ñandú 😀.txt', txt.size, 1000],
    ]);
    for (const f of list) expect(f.key.startsWith(`${SCOPE}${SHARE_INBOX_PATH}`)).toBe(true);

    const back = await readSharedFile(caches, list[1]);
    expect(await back?.text()).toBe('01/01/2026 10:00 - A: hi\n');
    expect(back?.name).toBe('Ñandú 😀.txt');
  });

  test('names never become paths: a traversal-looking name is only metadata', async () => {
    const caches = createMemoryCacheStorage();
    await storeSharedFiles(caches, SCOPE, [zip('../../etc/passwd.zip')], 5);
    const [only] = await listSharedFiles(caches);
    expect(only.name).toBe('../../etc/passwd.zip');
    expect(only.key).toBe(`${SCOPE}${SHARE_INBOX_PATH}5-0`);
  });

  test('bounded count, empty inbox, removal', async () => {
    const caches = createMemoryCacheStorage();
    expect(await listSharedFiles(caches)).toEqual([]);
    expect(await storeSharedFiles(caches, SCOPE, [])).toBe(0);
    const many = Array.from({ length: MAX_SHARED_FILES + 5 }, (_, i) => zip(`c${i}.zip`));
    expect(await storeSharedFiles(caches, SCOPE, many, 7)).toBe(MAX_SHARED_FILES);
    const list = await listSharedFiles(caches);
    expect(list).toHaveLength(MAX_SHARED_FILES);
    expect(await removeSharedFile(caches, list[0].key)).toBe(true);
    expect(await listSharedFiles(caches)).toHaveLength(MAX_SHARED_FILES - 1);
  });
});
