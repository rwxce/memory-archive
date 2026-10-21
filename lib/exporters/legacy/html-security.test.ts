import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { renderHtml } from './html';
import { renderMarkdown } from './md';
import { isHttpUrl, linkifyHtml, linkifyMarkdown, unwrapUrl } from './js/linkify.js';
import type { Message } from '../../importers/whatsapp/types';

const msg = (text: string, author = 'A'): Message => ({
  timestamp_iso: '2026-01-01T10:00:00',
  type: 'text',
  author,
  text,
  media: '',
});

const wrap = (target: string) =>
  `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(target)}`;

const DANGEROUS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'file:///etc/passwd',
  'vbscript:msgbox(1)',
];

describe('LinkedIn wrapper scheme check', () => {
  test.each(DANGEROUS)('unwrapUrl keeps the wrapper for %s', (target) => {
    const url = wrap(target);
    expect(unwrapUrl(url)).toBe(url);
  });

  test('a double-encoded dangerous target is also rejected', () => {
    const url = `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(encodeURIComponent('javascript:alert(1)'))}`;
    expect(unwrapUrl(url)).toBe(url);
  });

  test('a legit https target still unwraps', () => {
    expect(unwrapUrl(wrap('https://site.example/p?a=1'))).toBe('https://site.example/p?a=1');
    expect(unwrapUrl(wrap('http://site.example/'))).toBe('http://site.example/');
  });

  test('isHttpUrl accepts only http(s)', () => {
    expect(isHttpUrl('https://a.example')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  test.each(DANGEROUS)('linkify HTML/Markdown emit no %s href', async (target) => {
    const text = `see ${wrap(target)} now`;
    const hrefs = [...linkifyHtml(text).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(1);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\/www\.linkedin\.com\//);
    expect(linkifyMarkdown(text)).not.toMatch(/\]\((javascript|data|file|vbscript):/i);

    const html = await renderHtml([msg(text)], 'Chat');
    expect(html).not.toMatch(/href="\s*(javascript|data|file|vbscript):/i);
    const md = await renderMarkdown([msg(text)], 'Chat');
    expect(md).not.toMatch(/\]\(\s*(javascript|data|file|vbscript):/i);
  });

  test('a legit wrapper links to the real destination in HTML and Markdown', async () => {
    const text = wrap('https://site.example/p');
    expect(await renderHtml([msg(text)], 'Chat')).toContain('<a href="https://site.example/p"');
    expect(await renderMarkdown([msg(text)], 'Chat')).toContain('(https://site.example/p)');
  });
});

describe('messages.html escaping', () => {
  test('the JSON island escapes < and U+2028/2029', async () => {
    const html = await renderHtml(
      [msg('</script><script>alert(1)</script><!-- \u2028 \u2029', 'x<b>')],
      'Chat',
    );
    const island = /<script type="application\/json" id="chat-data">([\s\S]*?)<\/script>/.exec(html);
    expect(island).not.toBeNull();
    const raw = island![1];
    expect(raw).not.toContain('<');
    expect(raw).not.toMatch(/[\u2028\u2029]/);
    const parsed = JSON.parse(raw);
    expect(parsed.messages[0].text).toBe('</script><script>alert(1)</script><!-- \u2028 \u2029');
    expect(html).not.toContain('<script>alert(1)');
  });

  test('every bubble time is escaped HTML', async () => {
    const html = await renderHtml([msg('hi')], 'Chat');
    expect(html).toContain('<span class="bubble-time">10:00</span>');
  });
});

describe('messages.html Content-Security-Policy', () => {
  test('script hashes match the executable inline blocks exactly', async () => {
    const html = await renderHtml([msg('hello https://example.com')], 'Chat');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('connect-src');
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);

    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(blocks.length).toBe(4);
    const scriptSrc = /script-src ([^;]*)/.exec(csp)![1].split(' ');
    const hashes = blocks.map(
      (b) => `'sha256-${createHash('sha256').update(b, 'utf8').digest('base64')}'`,
    );
    expect(scriptSrc).toEqual(hashes);
  });
});
