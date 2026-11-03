import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../domain/sha256';
import { openZipEntry, readZipEntries, readZipEntryBytes } from '../../importers/whatsapp/zip';
import { ArchiveError } from '../archive/format';
import { GENERATOR_NAME } from '../legacy/version';
import { VIEWER_DATA_FORMAT, VIEWER_SCHEMA_VERSION, type ViewerData, parseViewerData } from './format';
import { VIEWER_DATA_ISLAND } from './html';
import { VIEWER_HTML_PATH, VIEWER_README, VIEWER_README_PATH, writeViewerPackage } from './write';

const TEMPLATE = `<html><body><div id="app"></div>${VIEWER_DATA_ISLAND}<script>run()</script></body></html>`;
const bytesA = new Uint8Array([1, 2, 3, 4]);
const bytesB = new Uint8Array(1000).fill(7);
const shaA = sha256Hex(bytesA);
const shaB = sha256Hex(bytesB);
const stream = (b: Uint8Array) => new Blob([b as BlobPart]).stream();

function data(over: Partial<ViewerData> = {}, title = 'Chat'): ViewerData {
  return {
    format: VIEWER_DATA_FORMAT,
    schemaVersion: VIEWER_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: '0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    selection: { from: null, to: null, includeMedia: true },
    profiles: [],
    conversations: [{ id: 'c', title, source: 'whatsapp', isGroup: false, profileIds: [], participants: [], messages: [] }],
    media: [
      { sha256: shaB, path: `media/${shaB}.bin`, size: bytesB.length, mime: null },
      { sha256: shaA, path: `media/${shaA}.jpg`, size: bytesA.length, mime: 'image/jpeg' },
    ],
    ...over,
  };
}

const store: Record<string, Uint8Array> = { [shaA]: bytesA, [shaB]: bytesB };
const readBlob = async (sha: string) => (store[sha] ? stream(store[sha]) : undefined);
const text = async (zip: Blob, name: string) => {
  const entry = (await readZipEntries(zip)).find((e) => e.name === name)!;
  return new TextDecoder().decode(await readZipEntryBytes(zip, entry));
};
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ArchiveError).code;

describe('writeViewerPackage', () => {
  test('has viewer.html, README.txt and stored media, read back with the ZIP reader', async () => {
    const progress: [number, number][] = [];
    const zip = await writeViewerPackage({ data: data(), readBlob, template: TEMPLATE, onProgress: (d, t) => progress.push([d, t]) });
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([VIEWER_HTML_PATH, VIEWER_README_PATH, `media/${shaB}.bin`, `media/${shaA}.jpg`]);
    expect(entries.filter((e) => e.name.startsWith('media/')).every((e) => e.compression === 0)).toBe(true);
    const media = entries.find((e) => e.name === `media/${shaA}.jpg`)!;
    const chunks: Uint8Array[] = [];
    for await (const c of openZipEntry(zip, media) as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
    expect(sha256Hex(chunks[0])).toBe(shaA);
    expect(await text(zip, VIEWER_README_PATH)).toBe(VIEWER_README);
    expect(VIEWER_README).toMatch(/EN[\s\S]*CA[\s\S]*ES/);
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  test('the data island appears once, hostile text cannot inject a script, data reads back', async () => {
    const hostile = '</script><script>alert(1)</script><!-- $& -->';
    const zip = await writeViewerPackage({ data: data({}, hostile), readBlob, template: TEMPLATE });
    const html = await text(zip, VIEWER_HTML_PATH);
    expect(html.split('id="viewer-data"')).toHaveLength(2);
    expect(html.match(/<script/g)).toHaveLength(2);
    const island = /id="viewer-data">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(parseViewerData(island).conversations[0].title).toBe(hostile);
  });

  test('without media only the HTML and README are written', async () => {
    const zip = await writeViewerPackage({ data: data({ media: [], selection: { from: null, to: null, includeMedia: false } }), readBlob, template: TEMPLATE });
    expect((await readZipEntries(zip)).map((e) => e.name)).toEqual([VIEWER_HTML_PATH, VIEWER_README_PATH]);
  });

  test.each(['../evil.jpg', '/abs.jpg', 'C:/x.jpg', `media/../${shaA}.jpg`, `media/${shaA}.JPG`, `media/${shaB}.jpg`, `x/${shaA}.jpg`])(
    'refuses the hostile or mismatched path %s',
    async (path) => {
      const media = [{ sha256: shaA, path, size: 4, mime: null }];
      expect(await code(writeViewerPackage({ data: data({ media }), readBlob, template: TEMPLATE }))).toBe('unsafe-path');
    },
  );

  test('refuses duplicate paths and oversized entries', async () => {
    const one = { sha256: shaA, path: `media/${shaA}.jpg`, size: 4, mime: null };
    expect(await code(writeViewerPackage({ data: data({ media: [one, one] }), readBlob, template: TEMPLATE }))).toBe('unsafe-path');
    expect(await code(writeViewerPackage({ data: data({ media: [{ ...one, size: 2 ** 40 }] }), readBlob, template: TEMPLATE }))).toBe('limit-exceeded');
  });

  test('a missing blob, a changed blob and a longer blob abort', async () => {
    const m = data().media;
    expect(await code(writeViewerPackage({ data: data({ media: m }), readBlob: async () => undefined, template: TEMPLATE }))).toBe('blob-missing');
    const flipped = new Uint8Array(bytesA).fill(9);
    const bad = async (sha: string) => stream(sha === shaA ? flipped : store[sha]);
    expect(await code(writeViewerPackage({ data: data(), readBlob: bad, template: TEMPLATE }))).toBe('integrity');
    const longer = async (sha: string) => stream(sha === shaA ? new Uint8Array(50) : store[sha]);
    expect(await code(writeViewerPackage({ data: data(), readBlob: longer, template: TEMPLATE }))).toBe('integrity');
  });

  test('a template without the island is refused', async () => {
    expect(await code(writeViewerPackage({ data: data(), readBlob, template: '<html></html>' }))).toBe('storage');
  });
});
