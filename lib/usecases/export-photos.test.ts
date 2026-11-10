import { describe, expect, test } from 'vitest';
import { parseViewerData } from '../exporters/viewer/format';
import { VIEWER_DATA_ISLAND } from '../exporters/viewer/html';
import { readZipEntries, readZipEntryBytes } from '../importers/whatsapp/zip';
import type { NewMessage } from '../domain/library';
import type { NewPhotoItem } from '../domain/photo';
import { exportPackage, type ExportFormat } from './export-package';
import { assignPhotos } from './photo-assign';
import { createTestLibrary } from './test-client';
import { buildViewerExport } from './viewer-export';

/** Assigned photos in every export (docs/formats/viewer-data.md, export-package.md). Synthetic data only. */

const NOW = '2026-02-01T12:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const [ANA, BEN, C_ANA] = [uuid(1), uuid(2), uuid(10)];

const item = (sha256: string, over: Partial<NewPhotoItem> = {}): NewPhotoItem => ({
  sha256,
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: '2024-05-10T10:00:00Z',
  takenOffsetMinutes: null,
  dateSource: 'sidecar',
  latitude: null,
  longitude: null,
  description: '',
  album: '',
  fileName: 'IMG.jpg',
  ...over,
});

async function setup() {
  const lib = await createTestLibrary();
  const put = (bytes: number[]) => lib.deps.blobStore.put(new Uint8Array(bytes));
  const [a, b, c, d] = [await put([1]), await put([2, 2]), await put([3, 3, 3]), await put([4, 4, 4, 4])];
  const gone = 'ef'.repeat(32); // in the collection, bytes never stored
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana <b>x</b>', now: NOW });
  await lib.client.call('createProfile', { id: BEN, displayName: 'Ben', now: NOW });
  const message = (n: number, over: Partial<NewMessage>): NewMessage => ({
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
  // `a` is both chat media and an assigned photo: it must be stored once.
  await lib.client.call('importMessages', {
    batchId: uuid(100),
    conversationId: C_ANA,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: NOW,
    blobs: [{ sha256: a.sha256, size: 1, mime: 'image/jpeg' }],
    messages: [message(1, {}), message(2, { type: 'photo', mediaSha256: a.sha256, mediaName: 'IMG-1.jpg' })],
    newConversation: { title: 'Chat with Ana', sourceKey: 'a', isGroup: false, profileIds: [ANA] },
    meAuthor: 'Ana',
  });
  const items: NewPhotoItem[] = [
    item(a.sha256, { fileName: 'IMG-1.jpg', album: 'Trip' }),
    item(b.sha256, { takenAt: '2023-03-01T10:00:00Z', fileName: '"><img src=x onerror=alert(1)>.jpg', album: '</script>' }),
    item(c.sha256, { kind: 'video', mime: 'video/mp4', takenAt: '2024-12-24T22:00:00Z', fileName: 'clip.mp4' }),
    item(d.sha256, { takenAt: null, dateSource: 'none', fileName: 'undated.jpg' }),
    item(gone, { takenAt: '2024-01-01T10:00:00Z', fileName: 'gone.jpg' }),
  ];
  await lib.client.call('importPhotoItems', {
    batchId: uuid(101),
    source: 'loose',
    sourceLabel: 'f',
    now: NOW,
    blobs: [...items.map((i) => ({ sha256: i.sha256, size: 1, mime: null }))],
    items,
  });
  await assignPhotos(lib.deps, { sha256s: [a.sha256, b.sha256, c.sha256, d.sha256, gone], profileIds: [ANA] });
  await assignPhotos(lib.deps, { sha256s: [a.sha256], profileIds: [BEN] });
  return { ...lib, a: a.sha256, b: b.sha256, c: c.sha256, d: d.sha256, gone };
}

const names = async (blob: Blob) => (await readZipEntries(blob)).map((e) => e.name);
const read = async (blob: Blob, name: string) => {
  const entry = (await readZipEntries(blob)).find((e) => e.name === name)!;
  return new TextDecoder().decode(await readZipEntryBytes(blob, entry));
};
const sel = (over: Record<string, unknown> = {}) => ({ profileIds: [ANA], includeMedia: true, ...over });

describe('assigned photos in the viewer data', () => {
  test('the profile lists its available pictures newest first, undated last; one file per hash', async () => {
    const { deps, a, b, c, d } = await setup();
    const { data, media, missingMedia } = await buildViewerExport(deps, sel());
    const photos = data.profiles[0].photos!;
    expect(photos.map((p) => p.sha256)).toEqual([c, a, b, d]);
    expect(photos[0]).toEqual({
      sha256: c,
      path: `media/${c}.mp4`,
      kind: 'video',
      mime: 'video/mp4',
      takenAt: '2024-12-24T22:00:00Z',
      takenOffsetMinutes: null,
      dateSource: 'sidecar',
      fileName: 'clip.mp4',
      albums: [],
    });
    expect(photos[1].albums).toEqual(['Trip']);
    // The chat photo `a` is also assigned: one media entry, shared path.
    expect(media.filter((m) => m.sha256 === a)).toHaveLength(1);
    expect(photos[1].path).toBe(data.conversations[0].messages[1].media);
    expect(media).toHaveLength(4);
    expect(missingMedia).toBe(1);
    expect(parseViewerData(JSON.stringify(data)).profiles[0].photos).toHaveLength(4);
  });

  test('includeMedia false: no photos list and no files', async () => {
    const { deps } = await setup();
    const { data, media } = await buildViewerExport(deps, sel({ includeMedia: false }));
    expect(data.profiles[0].photos).toBeUndefined();
    expect(media).toEqual([]);
  });

  test('date range uses the picture display date; undated pictures only when no range is set', async () => {
    const { deps, a, c } = await setup();
    const some = await buildViewerExport(deps, sel({ from: '2024-05-01', to: '2024-12-31' }));
    expect(some.data.profiles[0].photos!.map((p) => p.sha256)).toEqual([c, a]);
    const one = await buildViewerExport(deps, sel({ to: '2024-05-10' }));
    expect(one.data.profiles[0].photos!.map((p) => p.sha256)).not.toContain(c);
    const none = await buildViewerExport(deps, sel({ from: '2030-01-01' }));
    expect(none.data.profiles[0].photos).toEqual([]);
  });

  test('a profile without assigned photos gets an empty list; each profile keeps its own', async () => {
    const { deps, a } = await setup();
    const { data } = await buildViewerExport(deps, sel({ profileIds: [ANA, BEN] }));
    const byId = new Map(data.profiles.map((p) => [p.id, p.photos!.map((x) => x.sha256)]));
    expect(byId.get(BEN)).toEqual([a]);
    expect(byId.get(ANA)).toHaveLength(4);
    expect(data.media.filter((m) => m.sha256 === a)).toHaveLength(1);
  });
});

describe('assigned photos in the packages', () => {
  test('json: the list is in the envelope and the bytes sit in media/', async () => {
    const { deps, a, b, c, d } = await setup();
    const out = await exportPackage(deps, { format: 'json', selection: sel() });
    const list = await names(out.blob);
    expect(list.filter((n) => n.startsWith('media/')).sort()).toEqual([`media/${a}.jpg`, `media/${b}.jpg`, `media/${c}.mp4`, `media/${d}.jpg`].sort());
    const data = parseViewerData(await read(out.blob, 'memory-archive.json'));
    expect(data.profiles[0].photos).toHaveLength(4);
    expect(out.mediaCount).toBe(4);
    expect(out.missingMedia).toBe(1);
  });

  test('viewer: the data island carries the photos', async () => {
    const { deps, c } = await setup();
    const out = await exportPackage(deps, { format: 'viewer', selection: sel(), loadTemplate: async () => `<html>${VIEWER_DATA_ISLAND}</html>` });
    expect(await names(out.blob)).toContain(`media/${c}.mp4`);
    expect(await read(out.blob, 'viewer.html')).toContain(c);
  });

  test.each([['html', 'html'], ['markdown', 'md']] as [ExportFormat, string][])('%s: a photos page per profile, relative links, hostile names inert', async (format, ext) => {
    const { deps, a, b, c } = await setup();
    const out = await exportPackage(deps, { format, selection: sel({ profileIds: [ANA, BEN] }), lang: 'ca' });
    const list = await names(out.blob);
    expect(list).toContain(`photos-ana-b-x-b.${ext}`);
    expect(list).toContain(`photos-ben.${ext}`);
    const page = await read(out.blob, `photos-ana-b-x-b.${ext}`);
    for (const sha of [a, b, c]) expect(page).toContain(`media/${sha}.`);
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('</script>');
    expect(page).not.toContain('<b>x</b>');
    expect(page).not.toMatch(/https?:\/\//);
    if (format === 'html') {
      expect(page).toContain('<html lang="ca"');
      expect(page).toContain("default-src 'none'");
    }
    expect((await read(out.blob, `photos-ben.${ext}`)).split(`media/${a}`).length).toBeGreaterThan(1);
  });

  test('media off: no photos page and no files', async () => {
    const { deps } = await setup();
    for (const format of ['html', 'markdown'] as ExportFormat[]) {
      const out = await exportPackage(deps, { format, selection: sel({ includeMedia: false }) });
      const list = await names(out.blob);
      expect(list.some((n) => n.startsWith('photos-') || n.includes('media/'))).toBe(false);
    }
  });

  test('perProfile: each folder has its own photos page and media, none duplicated inside a folder', async () => {
    const { deps, a } = await setup();
    const out = await exportPackage(deps, { format: 'html', selection: sel({ profileIds: [ANA, BEN] }), split: 'perProfile' });
    const list = await names(out.blob);
    expect(list).toContain('ana-b-x-b/photos-ana-b-x-b.html');
    expect(list).toContain('ben/photos-ben.html');
    expect(list.filter((n) => n.startsWith('ben/media/'))).toEqual([`ben/media/${a}.jpg`]);
    expect(list.filter((n) => n.startsWith('ana-b-x-b/media/'))).toHaveLength(4);
    expect(new Set(list).size).toBe(list.length);
  });

  test('a profile with only photos (no messages in the range) still exports its photos page', async () => {
    const { deps } = await setup();
    const out = await exportPackage(deps, { format: 'markdown', selection: sel({ profileIds: [BEN], from: '2024-01-01' }) });
    expect(await names(out.blob)).toContain('photos-ben.md');
  });
});
