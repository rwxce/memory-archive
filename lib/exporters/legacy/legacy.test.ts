import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256 } from './sha256';
import { accentHue } from './colors';
import { csvField, mergeMessages, parseCsv, parseCsvRecords, serializeCsv, unescapeField } from './csv';
import { buildMediaMap, bytesToBase64, extOf } from './media';
import { renderHtml, resolveSelfAuthor, transcriptItems } from './html';
import { renderMarkdown } from './md';
import { renderJson } from './json';
import { GENERATOR_NAME, GENERATOR_VERSION } from './version';
import { VIEWER_SCRIPT } from './js/viewer-script.generated';
import type { Message } from '../../importers/whatsapp/types';

const msg = (timestamp_iso: string, author: string, text: string, media = ''): Message => ({
  timestamp_iso,
  type: media ? 'photo' : 'text',
  author,
  text,
  media,
});

describe('sha256 (sync, platform-neutral)', () => {
  test.each(['', 'abc', 'Alice Example', '\u202a+00 555 0100 1234\u202c', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)])(
    'matches node:crypto for %j',
    (input) => {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      const actual = Buffer.from(sha256(new TextEncoder().encode(input))).toString('hex');
      expect(actual).toBe(expected);
    },
  );

  test('accent hue is the first 4 bytes of the digest modulo 360', () => {
    const d = createHash('sha256').update('Ana', 'utf8').digest();
    expect(accentHue('Ana')).toBe(d.readUInt32BE(0) % 360);
  });
});

describe('csv (pure)', () => {
  test('serialize -> parse round-trip', () => {
    const rows = [{ ...msg('2026-01-01T00:00:00', 'A,B', 'line\nwith "quotes"'), urlTitles: {} }];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });

  test.each([
    '=HYPERLINK("http://x","y")',
    '@SUM(1)',
    '+1',
    '-1',
    '+55 11 91234-5678',
    '\tTAB',
    '\rCR',
    "'=x",
    "''+1",
    "'plain",
    '=a\nb',
    'a=b',
  ])('csv round-trips %j unchanged and neutralises formulas', (value) => {
    const row = { ...msg('2026-01-01T00:00:00', value, value), media: value, urlTitles: { u: value } };
    expect(parseCsv(serializeCsv([row]))).toEqual([row]);
    const line = serializeCsv([row]).split('\n')[1];
    const cells = parseCsvRecords(line + '\n')[0];
    for (const cell of cells.slice(2, 5)) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  test('csvField prefixes a single quote on formula-looking values only', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+55')).toBe("'+55");
    expect(csvField('hello')).toBe('hello');
    expect(csvField("it's")).toBe("it's");
    expect(unescapeField("'=1+1")).toBe('=1+1');
    // Pre-fix backups (no guard) stay readable.
    expect(unescapeField('=1+1')).toBe('=1+1');
    expect(unescapeField('+55')).toBe('+55');
  });

  test('mergeMessages dedupes and sorts stably', () => {
    const a = msg('2026-01-01T10:00:00', 'A', 'one');
    const b = msg('2026-01-01T09:00:00', 'B', 'zero');
    const { messages, added } = mergeMessages([a], [a, b]);
    expect(added).toBe(1);
    expect(messages).toEqual([b, a]);
  });

  test('mergeMessages counts identical messages instead of collapsing them', () => {
    const ok = msg('2026-01-01T12:30:00', 'A', 'ok');
    // First import keeps both "ok"s.
    expect(mergeMessages([], [ok, { ...ok }]).added).toBe(2);
    // Re-import of the same export adds nothing.
    expect(mergeMessages([ok, { ...ok }], [ok, { ...ok }]).added).toBe(0);
    // A newer export with a third "ok" adds exactly one.
    const r = mergeMessages([ok, { ...ok }], [ok, { ...ok }, { ...ok }]);
    expect(r.added).toBe(1);
    expect(r.messages).toHaveLength(3);
  });
});

describe('media + renderers (no file system)', () => {
  test('extOf / bytesToBase64', () => {
    expect(extOf('photo (1).JPG')).toBe('.JPG');
    expect(extOf('.hidden')).toBe('');
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  test('buildMediaMap resolves from a file list', () => {
    const map = buildMediaMap([{ name: 'IMG-1 (1).jpg', size: 3 }], [msg('2026-01-01T00:00:00', 'A', '', 'IMG-1.jpg')]);
    expect(map.get('IMG-1.jpg')).toEqual({
      relPath: 'media/IMG-1 (1).jpg',
      mime: 'image/jpeg',
      size: 3,
      inlineable: true,
    });
  });

  test('inline rendering uses the provided data-URI loader', async () => {
    const messages = [msg('2026-01-01T00:00:00', 'A', '', 'IMG-1.jpg')];
    const media = buildMediaMap([{ name: 'IMG-1.jpg', size: 2 }], messages);
    const loadDataUri = async () => 'data:image/jpeg;base64,aGk=';
    const html = await renderHtml(messages, 'Chat', { media, inline: true, loadDataUri });
    const md = await renderMarkdown(messages, 'Chat', { media, inline: true, loadDataUri });
    expect(html).toContain('src="data:image/jpeg;base64,aGk="');
    expect(md).toContain('](data:image/jpeg;base64,aGk=)');
  });
});

/**
 * Every URL the page would *load* by itself (not navigation links): `src`,
 * `srcset`, `poster`, `data`, `<link href>`, CSS `url()` and `@import`. Returns
 * only remote ones (`http:`, `https:` or protocol-relative `//`).
 */
function remoteResourceUrls(html: string): string[] {
  const found: string[] = [];
  const value = (m: RegExpMatchArray | RegExpExecArray) => m[1] ?? m[2] ?? m[3] ?? '';
  for (const m of html.matchAll(/\b(?:src|srcset|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    found.push(value(m));
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (href) found.push(value(href));
  }
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) found.push(value(m));
  for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) found.push(m[1]);
  return found.filter((u) => /^\s*(https?:)?\/\//i.test(u));
}

describe('no remote resources (privacy)', () => {
  const linky: Message[] = [
    msg('2026-01-01T10:00:00', 'A', 'see https://example.com/page and http://tracker.example/x'),
    msg('2026-01-01T10:01:00', 'B', 'LinkedIn https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fsite.example%2Fp'),
    { ...msg('2026-01-01T10:02:00', 'system', 'joined via https://chat.example/invite'), type: 'system' },
  ];

  test('the scanner itself catches remote src, link href, url() and @import', () => {
    expect(
      remoteResourceUrls(
        '<img src="https://a.example/i.png"><link rel="icon" href="//b.example/f.ico">' +
          '<style>@import "https://c.example/x.css"; a{background:url(https://d.example/z)}</style>',
      ),
    ).toEqual(['https://a.example/i.png', '//b.example/f.ico', 'https://d.example/z', 'https://c.example/x.css']);
    expect(remoteResourceUrls('<a href="https://example.com">x</a><img src="data:image/png;base64,AA">')).toEqual([]);
  });

  test('messages.html loads nothing from the network (no link favicons)', async () => {
    const html = await renderHtml(linky, 'Chat');
    expect(html).toContain('<a href="https://example.com/page"');
    expect(remoteResourceUrls(html)).toEqual([]);
    expect(html).not.toMatch(/favicon/i);
  });

  test('the in-page viewer script never builds favicon URLs', () => {
    expect(VIEWER_SCRIPT).not.toMatch(/favicon/i);
  });
});

describe('versioned JSON envelope', () => {
  test('schemaVersion 1 and generator identity, kept in sync with package.json', async () => {
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { name: string; version: string };
    expect(GENERATOR_VERSION).toBe(pkg.version);
    expect(GENERATOR_NAME).toBe(pkg.name);
    const env = JSON.parse(renderJson([msg('2026-01-01T00:00:00', 'A', 'x')], 'Chat'));
    expect(env.schemaVersion).toBe(1);
    expect(env.generator).toEqual({ name: 'memory-archive', version: pkg.version });
    expect(Object.keys(env)).toEqual(['schemaVersion', 'generator', 'metadata', 'messages']);
  });
});

describe('transcript structure', () => {
  test('day separators are explicit items, one per calendar day', () => {
    const items = transcriptItems([
      msg('2026-01-01T10:00:00', 'A', 'one'),
      msg('2026-01-01T10:01:00', 'A', 'two'),
      msg('2026-01-01T23:59:00', 'B', 'three'),
      msg('2026-01-02T00:00:00', 'B', 'four'),
    ]);
    expect(items.map((i) => (i.kind === 'day' ? `day:${i.day}` : `group:${i.messages.length}`))).toEqual([
      'day:2026-01-01',
      'group:2',
      'group:1',
      'day:2026-01-02',
      'group:1',
    ]);
  });

  test('a message whose rendered HTML looks like a date is never taken for a day pill', async () => {
    // The old renderer recognised day markers by string shape (length 10, "-" at 4).
    const html = await renderHtml([msg('2026-01-01T10:00:00', 'A', '2026-01-01')], 'Chat');
    expect(html.match(/class="day-pill"/g)).toHaveLength(1);
    expect(html).toContain('<span class="bubble-text">2026-01-01</span>');
  });

  test('resolveSelfAuthor: explicit me (ignoring case/bidi marks) or the most frequent author', () => {
    const messages = [
      msg('2026-01-01T10:00:00', 'Ana', 'x'),
      msg('2026-01-01T10:01:00', 'Ana', 'y'),
      msg('2026-01-01T10:02:00', '\u202a+00 555 0101\u202c', 'z'),
    ];
    expect(resolveSelfAuthor(messages)).toBe('Ana');
    expect(resolveSelfAuthor(messages, '+00 555 0101')).toBe('\u202a+00 555 0101\u202c');
    expect(resolveSelfAuthor(messages, 'nobody')).toBe('Ana');
  });
});
