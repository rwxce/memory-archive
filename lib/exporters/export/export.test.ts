import { describe, expect, test } from 'vitest';
import { buildViewerData } from '../viewer/build';
import { parseViewerData } from '../viewer/format';
import { writeExportZip } from './write';
import { layoutExport } from './files';
import { folderNames, numberedName, slug } from './names';

const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);

function dataFor(title: string, over: { author?: string; text?: string; mediaName?: string } = {}) {
  return buildViewerData({
    now: '2026-02-01T12:00:00Z',
    from: null,
    to: null,
    includeMedia: true,
    profiles: [{ id: 'p1', displayName: 'Ana', relationship: '', description: '' }],
    conversations: [
      {
        id: 'c1',
        title,
        source: 'whatsapp',
        isGroup: false,
        profileIds: ['p1'],
        participants: [{ displayName: over.author ?? 'Ana', isMe: true }],
        messages: [
          { sentAt: '2026-01-01T10:00:00', type: 'text', participantName: over.author ?? 'Ana', isMe: true, body: over.text ?? 'hello', mediaSha256: null, mediaName: '', mediaMime: null },
          { sentAt: '2026-01-01T10:01:00', type: 'photo', participantName: over.author ?? 'Ana', isMe: true, body: '', mediaSha256: HASH, mediaName: over.mediaName ?? 'IMG-1.JPG', mediaMime: 'image/jpeg' },
          { sentAt: '2026-01-01T10:02:00', type: 'photo', participantName: 'Ben', isMe: false, body: '', mediaSha256: HASH2, mediaName: 'IMG-2.png', mediaMime: 'image/png' },
        ],
      },
    ],
    availableMedia: new Map([[HASH, 3]]),
  });
}

describe('names', () => {
  test('slug keeps [a-z0-9-] only, folds accents, bounds the length and falls back', () => {
    expect(slug('Crème Brûlée / ../../etc', 'x')).toBe('creme-brulee-etc');
    expect(slug('C:\\Windows\\x', 'x')).toBe('c-windows-x');
    expect(slug('💬💬', 'chat')).toBe('chat');
    expect(slug('a'.repeat(200), 'x')).toHaveLength(40);
    expect(slug('\u0000\n<b>', 'x')).toBe('b');
  });
  test('numbered names are unique and ordered; folder names get a suffix on collision', () => {
    expect(numberedName(0, 3, 'Family', 'chat')).toBe('001-family');
    expect(numberedName(1, 1200, 'Family', 'chat')).toBe('0002-family');
    expect(folderNames(['Ana', 'ana', 'ANA!', ''])).toEqual(['ana', 'ana-2', 'ana-3', 'profile']);
  });
});

describe('layoutExport photos', () => {
  const photoData = (name: string, profileName = 'Ana') => {
    const data = dataFor('Chat');
    data.profiles[0].displayName = profileName;
    data.profiles[0].photos = [
      { sha256: HASH, path: `media/${HASH}.jpg`, kind: 'photo', mime: 'image/jpeg', takenAt: '2024-05-10T10:00:00Z', takenOffsetMinutes: null, dateSource: 'sidecar', fileName: name, albums: ['<i>Trip</i>'] },
    ];
    return data;
  };

  test('html and markdown get a photos page per profile with photos, named from the slug only', async () => {
    for (const [format, ext] of [['html', 'html'], ['markdown', 'md']] as const) {
      const { files } = await layoutExport(format, 'together', [{ name: '', data: photoData('x.jpg', '../../<b>Ana</b>') }]);
      expect(files.map((f) => f.path)).toEqual([`001-chat.${ext}`, `photos-b-ana-b.${ext}`]);
    }
    const split = await layoutExport('html', 'perProfile', [{ name: 'Ana', data: photoData('x.jpg') }]);
    expect(split.files.map((f) => f.path)).toEqual(['ana/001-chat.html', 'ana/photos-ana.html']);
  });

  test('json carries the list inside the envelope and writes no extra file', async () => {
    const { files } = await layoutExport('json', 'together', [{ name: '', data: photoData('x.jpg') }]);
    expect(files.map((f) => f.path)).toEqual(['memory-archive.json']);
    expect(parseViewerData(files[0].text).profiles[0].photos).toHaveLength(1);
  });

  test('hostile file and album names are escaped in the html page and in the markdown page', async () => {
    const hostile = '"><script>alert(1)</script>[x](javascript:alert(2))\n# h.jpg';
    const html = (await layoutExport('html', 'together', [{ name: '', data: photoData(hostile) }])).files[1].text;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>Trip</i>');
    expect(html).toContain(`href="media/${HASH}.jpg"`);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    const md = (await layoutExport('markdown', 'together', [{ name: '', data: photoData(hostile) }])).files[1].text;
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<i>');
    expect(md).not.toMatch(/\n# h/);
    expect(md).not.toContain('[x](javascript');
    expect(md).toContain(`(media/${HASH}.jpg)`);
  });
});

describe('layoutExport', () => {
  test('json: the viewer envelope, parseable, media paths prefixed per folder', async () => {
    const together = await layoutExport('json', 'together', [{ name: 'x', data: dataFor('Chat') }]);
    expect(together.files.map((f) => f.path)).toEqual(['memory-archive.json']);
    expect(parseViewerData(together.files[0].text).conversations[0].title).toBe('Chat');
    expect(together.media).toEqual([{ path: `media/${HASH}.jpg`, sha256: HASH, size: 3 }]);
    const split = await layoutExport('json', 'perProfile', [{ name: 'Ana', data: dataFor('Chat') }]);
    expect(split.files[0].path).toBe('ana/memory-archive.json');
    expect(split.media[0].path).toBe(`ana/media/${HASH}.jpg`);
  });

  test('html: one escaped page per conversation, hostile text stays inert, missing media is a placeholder', async () => {
    const hostile = dataFor('<img src=x onerror=alert(1)>/../../x', { author: '<script>1</script>', text: '</script><b>x</b>', mediaName: '"><i>.jpg' });
    const { files } = await layoutExport('html', 'together', [{ name: '', data: hostile }]);
    expect(files.map((f) => f.path)).toEqual(['001-img-src-x-onerror-alert-1-x.html']);
    const html = files[0].text;
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>1</script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(`src="media/${HASH}.jpg"`);
    expect(html).toContain('media-placeholder');
    expect(html).toContain("default-src 'none'");
  });

  test('markdown: one file per conversation; chat text cannot inject headings, links or HTML', async () => {
    const hostile = dataFor('# Title\n[x](javascript:alert(1))', { text: 'a\n# heading\n<b>x</b> [l](http://evil)', author: '**bold**' });
    const { files } = await layoutExport('markdown', 'together', [{ name: '', data: hostile }]);
    expect(files[0].path).toBe('001-title-x-javascript-alert-1.md');
    const md = files[0].text;
    expect(md.split('\n')[0]).toBe('# # Title \\[x\\](javascript:alert(1))');
    expect(md).not.toMatch(/^# heading/m);
    expect(md).toContain('\\# heading');
    expect(md).not.toContain('<b>');
    expect(md).not.toContain('**bold**');
    expect(md).toContain(`![IMG-1.JPG](media/${HASH}.jpg)`);
    expect(md).toContain('[📷 photo: IMG-2.png]');
  });

  test('lang: html and markdown headings follow it (default en), the title is the page title', async () => {
    const data = dataFor('Family');
    const en = await layoutExport('html', 'together', [{ name: '', data }]);
    expect(en.files[0].text).toContain('<html lang="en"');
    expect(en.files[0].text).toContain('<title>Family</title>');
    expect(en.files[0].text).toContain('January 01, 2026');
    const ca = await layoutExport('html', 'together', [{ name: '', data }], 'ca');
    expect(ca.files[0].text).toContain('01 de gener del 2026');
    const es = await layoutExport('markdown', 'together', [{ name: '', data }], 'es');
    expect(es.files[0].text).toContain('## 01 de enero de 2026');
  });

  test('deterministic: same input, same bytes', async () => {
    const a = await layoutExport('html', 'together', [{ name: '', data: dataFor('Chat') }]);
    const b = await layoutExport('html', 'together', [{ name: '', data: dataFor('Chat') }]);
    expect(a).toEqual(b);
  });
});

describe('writeExportZip', () => {
  const base = { createdAt: '2026-02-01T12:00:00Z', files: [], readBlob: async () => undefined };
  const entry = (path: string, sha256 = HASH) => ({ path, sha256, size: 3 });
  const code = async (media: ReturnType<typeof entry>[], readBlob: () => Promise<ReadableStream<Uint8Array> | undefined> = base.readBlob) =>
    ((await writeExportZip({ ...base, media, readBlob }).catch((e) => e)) as { code: string }).code;

  test('refuses paths that escape or do not belong to their own hash, and duplicates', async () => {
    for (const bad of [`../media/${HASH}.jpg`, `/media/${HASH}.jpg`, `C:/media/${HASH}.jpg`, `a/../media/${HASH}.jpg`, `a/b/media/${HASH}.jpg`, `media/${HASH2}.jpg`, `media/${HASH}.jpg/`]) {
      expect(await code([entry(bad)])).toBe('unsafe-path');
    }
    expect(await code([entry(`media/${HASH}.jpg`), entry(`media/${HASH}.jpg`)])).toBe('unsafe-path');
  });

  test('a missing blob aborts the export', async () => {
    expect(await code([entry(`ana/media/${HASH}.jpg`)])).toBe('blob-missing');
  });
});
