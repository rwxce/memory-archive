import { describe, expect, test } from 'vitest';
import { locales } from '@/i18n/routing';
import { listSharedFiles } from '@/lib/storage/share-inbox';
import { createMemoryCacheStorage } from '@/lib/storage/test-cache-storage';
import { handleShareTarget, offlinePageFor, SHARE_TARGET_FILES_FIELD, SW_LOCALES } from './share-target';

const SCOPE = 'https://app.example/memory-archive/';

function sharePost(files: File[], extra: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append(SHARE_TARGET_FILES_FIELD, f);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request(`${SCOPE}share-target/`, { method: 'POST', body: form });
}

describe('share target', () => {
  test('stores shared ZIP/TXT files and redirects (303) to the import screen', async () => {
    const caches = createMemoryCacheStorage();
    const res = await handleShareTarget(
      sharePost([
        new File([new Uint8Array([0x50, 0x4b])], 'WhatsApp Chat - Synthetic.zip', { type: 'application/zip' }),
        new File(['x'], 'p.jpg', { type: 'image/jpeg' }),
      ], { title: 'WhatsApp Chat' }),
      caches,
      SCOPE,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${SCOPE}?to=import&received=1`);
    expect((await listSharedFiles(caches)).map((f) => f.name)).toEqual(['WhatsApp Chat - Synthetic.zip']);
  });

  test('a malformed POST still redirects, storing nothing', async () => {
    const caches = createMemoryCacheStorage();
    const res = await handleShareTarget(
      new Request(`${SCOPE}share-target/`, { method: 'POST', body: 'not a form', headers: { 'content-type': 'text/plain' } }),
      caches,
      SCOPE,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('received=0');
    expect(await listSharedFiles(caches)).toEqual([]);
  });

  test('offline fallback page follows the URL language', () => {
    expect(offlinePageFor('/memory-archive/ca/settings/', '/memory-archive')).toBe('/memory-archive/ca/offline/index.html');
    expect(offlinePageFor('/es/x/', '')).toBe('/es/offline/index.html');
    expect(offlinePageFor('/', '')).toBe('/en/offline/index.html');
    expect(offlinePageFor('/de/', '')).toBe('/en/offline/index.html');
  });

  test('the worker knows the same locales as the app', () => {
    expect([...SW_LOCALES]).toEqual([...locales]);
  });
});
