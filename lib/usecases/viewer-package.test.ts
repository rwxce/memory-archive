import { describe, expect, test } from 'vitest';
import { VIEWER_DATA_ISLAND } from '../exporters/viewer/html';
import { parseViewerData } from '../exporters/viewer/format';
import { readZipEntries, readZipEntryBytes } from '../importers/whatsapp/zip';
import type { NewMessage } from '../domain/library';
import { createTestLibrary } from './test-client';
import { ViewerPackageError, exportViewerPackage, fetchViewerTemplate, type ViewerPackageProgress } from './viewer-package';

const TEMPLATE = `<html><body>${VIEWER_DATA_ISLAND}</body></html>`;
const NOW = '2026-02-01T12:00:00Z';
const ANA = '00000000-0000-4000-8000-000000000001';
const CONV = '00000000-0000-4000-8000-00000000000a';

const msg = (n: number, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-0${n}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

async function setup() {
  const lib = await createTestLibrary();
  const stored = await lib.deps.blobStore.put(new Uint8Array([1, 2, 3]));
  const gone = 'cd'.repeat(32);
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
  await lib.client.call('importMessages', {
    batchId: '00000000-0000-4000-8000-000000000064',
    conversationId: CONV,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [
      { sha256: stored.sha256, size: 3, mime: 'image/jpeg' },
      { sha256: gone, size: 9, mime: 'image/png' },
    ],
    messages: [
      msg(1, { body: '</script><b>x</b>' }),
      msg(2, { type: 'photo', mediaSha256: stored.sha256, mediaName: '../../evil.JPG' }),
      msg(3, { type: 'photo', mediaSha256: gone, mediaName: 'IMG-2.png' }),
    ],
    newConversation: { title: 'Chat', sourceKey: 'k', isGroup: false, profileIds: [ANA] },
    meAuthor: 'Ana',
  });
  return { ...lib, hash: stored.sha256 };
}

const loadTemplate = async () => TEMPLATE;

describe('exportViewerPackage', () => {
  test('builds the package: HTML with the data, media by hash, hostile names stay out of paths', async () => {
    const { deps, hash } = await setup();
    const events: ViewerPackageProgress[] = [];
    const out = await exportViewerPackage(deps, {
      selection: { profileIds: [ANA], includeMedia: true },
      loadTemplate,
      onProgress: (p) => events.push(p),
    });
    expect(out.mediaCount).toBe(1);
    expect(out.missingMedia).toBe(1);
    expect(out.fileName).toMatch(/^memory-archive-viewer-\d{4}-\d{2}-\d{2}\.zip$/);
    const entries = await readZipEntries(out.blob);
    expect(entries.map((e) => e.name)).toEqual(['viewer.html', 'README.txt', `media/${hash}.jpg`]);
    const html = new TextDecoder().decode(await readZipEntryBytes(out.blob, entries[0]));
    expect(html.match(/id="viewer-data"/g)).toHaveLength(1);
    expect(html).not.toContain('</script><b>');
    const island = /id="viewer-data">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(parseViewerData(island).conversations[0].messages[0].text).toBe('</script><b>x</b>');
    expect(events[0]).toEqual({ phase: 'reading' });
    expect(events).toContainEqual({ phase: 'media', done: 1, total: 1 });
    expect(events.at(-1)).toEqual({ phase: 'finishing' });
  });

  test('includeMedia false writes no media entries', async () => {
    const { deps } = await setup();
    const out = await exportViewerPackage(deps, { selection: { profileIds: [ANA], includeMedia: false }, loadTemplate });
    expect((await readZipEntries(out.blob)).map((e) => e.name)).toEqual(['viewer.html', 'README.txt']);
    expect(out.mediaCount).toBe(0);
  });

  test('typed errors: no profile, template missing or empty', async () => {
    const { deps } = await setup();
    const fail = async (p: Promise<unknown>) => (await p.catch((e) => e)) as ViewerPackageError;
    expect((await fail(exportViewerPackage(deps, { selection: { profileIds: [], includeMedia: true }, loadTemplate }))).code).toBe('no-profiles');
    const selection = { profileIds: [ANA], includeMedia: true };
    expect((await fail(exportViewerPackage(deps, { selection, loadTemplate: async () => { throw new Error('x'); } }))).code).toBe('template-missing');
    expect((await fail(exportViewerPackage(deps, { selection, loadTemplate: async () => '' }))).code).toBe('template-missing');
  });
});

describe('fetchViewerTemplate', () => {
  test('requests the app asset under the base path; failures are template-missing', async () => {
    const urls: string[] = [];
    const ok = (async (u: string) => (urls.push(u), new Response('<html>'))) as unknown as typeof fetch;
    expect(await fetchViewerTemplate('/sub', ok)()).toBe('<html>');
    expect(urls).toEqual(['/sub/viewer/viewer-template.html']);
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const error = await fetchViewerTemplate('', notFound)().catch((e) => e);
    expect(error).toBeInstanceOf(ViewerPackageError);
    expect(error.code).toBe('template-missing');
  });
});
