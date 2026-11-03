import { describe, expect, test } from 'vitest';
import { VIEWER_DATA_ISLAND } from '../exporters/viewer/html';
import { parseViewerData } from '../exporters/viewer/format';
import { readZipEntries, readZipEntryBytes } from '../importers/whatsapp/zip';
import type { NewMessage } from '../domain/library';
import { DbError, EXPORT_FORMATS, ViewerPackageError, exportPackage, type ExportFormat, type ExportProgress } from './export-package';
import { createTestLibrary } from './test-client';

const NOW = '2026-02-01T12:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, BEN, C_ANA, C_BEN] = [uuid(1), uuid(2), uuid(10), uuid(11)];

const msg = (n: number, day: number, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00`,
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
  await lib.client.call('createProfile', { id: BEN, displayName: 'ana', now: NOW });
  const imp = (batch: number, conversationId: string, title: string, key: string, profileIds: string[], messages: NewMessage[]) =>
    lib.client.call('importMessages', {
      batchId: uuid(100 + batch),
      conversationId,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [
        { sha256: stored.sha256, size: 3, mime: 'image/jpeg' },
        { sha256: gone, size: 9, mime: 'image/png' },
      ],
      messages,
      newConversation: { title, sourceKey: key, isGroup: false, profileIds },
      meAuthor: 'Ana',
    });
  await imp(1, C_ANA, '../Chat <b>with</b> Ana', 'a', [ANA], [
    msg(1, 1, { body: '</script><b>x</b>' }),
    msg(2, 5, { type: 'photo', mediaSha256: stored.sha256, mediaName: '../../evil.JPG' }),
    msg(3, 9, { type: 'photo', mediaSha256: gone, mediaName: 'IMG-2.png' }),
    msg(4, 20),
  ]);
  await imp(2, C_BEN, 'Chat with Ben', 'b', [BEN], [msg(5, 3, { participantName: 'Ben' })]);
  return { ...lib, hash: stored.sha256 };
}

const names = async (blob: Blob) => (await readZipEntries(blob)).map((e) => e.name);
const read = async (blob: Blob, name: string) => {
  const entry = (await readZipEntries(blob)).find((e) => e.name === name)!;
  return new TextDecoder().decode(await readZipEntryBytes(blob, entry));
};
const both = { profileIds: [ANA, BEN], includeMedia: true };

describe('exportPackage', () => {
  test('lists the formats the screen offers', () => {
    expect(EXPORT_FORMATS).toEqual(['viewer', 'html', 'json', 'markdown']);
  });

  test('viewer: delegates to the viewer package', async () => {
    const { deps, hash } = await setup();
    const out = await exportPackage(deps, {
      format: 'viewer',
      selection: { profileIds: [ANA], includeMedia: true },
      loadTemplate: async () => `<html>${VIEWER_DATA_ISLAND}</html>`,
    });
    expect(out.fileName).toMatch(/^memory-archive-viewer-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(await names(out.blob)).toEqual(['viewer.html', 'README.txt', `media/${hash}.jpg`]);
  });

  test('json together: one envelope, media beside it, hostile names stay out of paths', async () => {
    const { deps, hash } = await setup();
    const out = await exportPackage(deps, { format: 'json', selection: both });
    expect(out.fileName).toMatch(/^memory-archive-json-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(await names(out.blob)).toEqual(['memory-archive.json', `media/${hash}.jpg`]);
    const data = parseViewerData(await read(out.blob, 'memory-archive.json'));
    expect(data.conversations).toHaveLength(2);
    expect(data.conversations[0].messages[0].text).toBe('</script><b>x</b>');
    expect(out.mediaCount).toBe(1);
    expect(out.missingMedia).toBe(1);
  });

  test('perProfile: one folder per profile with its own media; same-name profiles get unique folders', async () => {
    const { deps, hash } = await setup();
    const out = await exportPackage(deps, { format: 'json', selection: both, split: 'perProfile' });
    const list = await names(out.blob);
    expect(list.filter((n) => n.endsWith('memory-archive.json')).sort()).toEqual(['ana-2/memory-archive.json', 'ana/memory-archive.json']);
    const folders = new Map<string, string[]>();
    for (const folder of ['ana', 'ana-2']) {
      const data = parseViewerData(await read(out.blob, `${folder}/memory-archive.json`));
      folders.set(folder, data.profiles.map((p) => p.id));
      expect(data.conversations.every((c) => c.profileIds.length === 1 && c.profileIds[0] === data.profiles[0].id)).toBe(true);
    }
    expect([...folders.values()].flat().sort()).toEqual([ANA, BEN]);
    const anaFolder = [...folders].find(([, ids]) => ids[0] === ANA)![0];
    expect(list.filter((n) => n.includes('/media/'))).toEqual([`${anaFolder}/media/${hash}.jpg`]);
  });

  test('html: a page per conversation, escaped, media linked relatively, nothing external', async () => {
    const { deps, hash } = await setup();
    const out = await exportPackage(deps, { format: 'html', selection: both });
    const list = await names(out.blob);
    expect(list).toEqual(['001-chat-b-with-b-ana.html', '002-chat-with-ben.html', `media/${hash}.jpg`]);
    const html = await read(out.blob, list[0]);
    expect(html).not.toContain('<b>with</b>');
    expect(html).not.toContain('</script><b>');
    expect(html).toContain(`src="media/${hash}.jpg"`);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  test('markdown: a file per conversation', async () => {
    const { deps, hash } = await setup();
    const out = await exportPackage(deps, { format: 'markdown', selection: both });
    expect(await names(out.blob)).toEqual(['001-chat-b-with-b-ana.md', '002-chat-with-ben.md', `media/${hash}.jpg`]);
    const md = await read(out.blob, '001-chat-b-with-b-ana.md');
    expect(md).toContain(`(media/${hash}.jpg)`);
    expect(md).not.toContain('<b>x</b>');
  });

  test('lang: reaches the html page (default en)', async () => {
    const { deps } = await setup();
    const en = await exportPackage(deps, { format: 'html', selection: both });
    expect(await read(en.blob, '002-chat-with-ben.html')).toContain('<html lang="en"');
    const ca = await exportPackage(deps, { format: 'html', selection: both, lang: 'ca' });
    const html = await read(ca.blob, '002-chat-with-ben.html');
    expect(html).toContain('<html lang="ca"');
    expect(html).not.toContain('WhatsApp Backup');
  });

  test('includeMedia false: no media entries, no paths', async () => {
    const { deps } = await setup();
    for (const format of ['html', 'json', 'markdown'] as ExportFormat[]) {
      const out = await exportPackage(deps, { format, selection: { ...both, includeMedia: false } });
      expect((await names(out.blob)).some((n) => n.includes('media/'))).toBe(false);
      expect(out.mediaCount).toBe(0);
    }
  });

  test('date range filters messages and drops empty conversations', async () => {
    const { deps } = await setup();
    const out = await exportPackage(deps, { format: 'json', selection: { ...both, from: '2026-01-04', to: '2026-01-10' } });
    const data = parseViewerData(await read(out.blob, 'memory-archive.json'));
    expect(data.conversations.map((c) => c.id)).toEqual([C_ANA]);
    expect(data.conversations[0].messages).toHaveLength(2);
  });

  test('deterministic output; progress has the viewer shape', async () => {
    const { deps } = await setup();
    const events: ExportProgress[] = [];
    const run = (onProgress?: (p: ExportProgress) => void) => exportPackage(deps, { format: 'markdown', selection: both, onProgress });
    const a = await run((p) => events.push(p));
    const b = await run();
    expect(await names(a.blob)).toEqual(await names(b.blob));
    expect(await read(a.blob, '001-chat-b-with-b-ana.md')).toBe(await read(b.blob, '001-chat-b-with-b-ana.md'));
    expect(events[0]).toEqual({ phase: 'reading' });
    expect(events).toContainEqual({ phase: 'media', done: 1, total: 1 });
    expect(events.at(-1)).toEqual({ phase: 'finishing' });
  });

  test('errors: no profiles, empty selection, bad dates, unknown profile, viewer without template', async () => {
    const { deps } = await setup();
    const fail = async (p: Promise<unknown>) => (await p.catch((e) => e)) as { code: string };
    expect((await fail(exportPackage(deps, { format: 'html', selection: { profileIds: [], includeMedia: true } }))).code).toBe('no-profiles');
    const empty = await fail(exportPackage(deps, { format: 'html', selection: { ...both, from: '2030-01-01' } }));
    expect(empty).toBeInstanceOf(ViewerPackageError);
    expect(empty.code).toBe('nothing-to-export');
    const bad = await fail(exportPackage(deps, { format: 'json', selection: { ...both, from: '2026-02-01', to: '2026-01-01' } }));
    expect(bad).toBeInstanceOf(DbError);
    expect(bad.code).toBe('invalid');
    expect((await fail(exportPackage(deps, { format: 'json', selection: { profileIds: [uuid(99)], includeMedia: true } }))).code).toBe('not-found');
    expect((await fail(exportPackage(deps, { format: 'viewer', selection: both }))).code).toBe('template-missing');
  });
});
