import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';
import {
  deriveTitle,
  linkifyHtml,
  linkifyMarkdown,
  faviconFor,
  unwrapUrl,
} from '../src/render/js/linkify.js';

const ROOT = process.cwd();

// ---- unit: deriveTitle ----

test('deriveTitle: strips scheme, www, trailing slash, query', () => {
  assert.equal(deriveTitle('https://www.github.com/owner/repo?x=1'), 'github.com/owner/repo');
  assert.equal(deriveTitle('http://example.com/'), 'example.com');
  assert.equal(deriveTitle('https://news.site/article/'), 'news.site/article');
  assert.equal(deriveTitle('https://example.com'), 'example.com');
});

// ---- unit: linkifyHtml ----

test('linkifyHtml: single URL -> <a> with derived title', () => {
  const out = linkifyHtml('see https://www.github.com/owner/repo now');
  assert.equal(
    out,
    'see <a href="https://www.github.com/owner/repo" target="_blank" rel="noopener noreferrer">github.com/owner/repo</a> now',
  );
});

test('linkifyHtml: multiple URLs', () => {
  const out = linkifyHtml('a https://x.com/a and https://y.com/b end');
  assert.equal((out.match(/<a /g) || []).length, 2, 'two anchors');
});

test('linkifyHtml: non-http scheme stays escaped text (no <a>)', () => {
  const out = linkifyHtml('run javascript:alert(1) now');
  assert.ok(!out.includes('<a'), 'no anchor for javascript:');
  assert.ok(out.includes('javascript:alert(1)'), 'text preserved');
});

test('linkifyHtml: XSS <script> escaped', () => {
  const out = linkifyHtml('<script>alert(1)</script>');
  assert.ok(out.includes('&lt;script&gt;'), 'script escaped');
  assert.ok(!out.includes('<script>alert'), 'no raw script');
});

test('linkifyHtml: href attribute is escaped', () => {
  const out = linkifyHtml('x https://e.com/a"b now');
  assert.ok(!/href="[^"]*"b/.test(out), 'quote in url does not break out');
  assert.ok(out.includes('&quot;'), 'quote escaped');
});

test('linkifyHtml: trailing sentence punctuation dropped from URL', () => {
  const out = linkifyHtml('see https://example.com/a. end');
  assert.ok(out.includes('href="https://example.com/a"'), 'trailing dot removed');
  assert.ok(!out.includes('example.com/a."'), 'no trailing dot in href');
});

// ---- unit: linkifyMarkdown ----

test('linkifyMarkdown: single URL -> [title](url)', () => {
  const out = linkifyMarkdown('see https://www.github.com/owner/repo now');
  assert.equal(
    out,
    'see [github.com/owner/repo](https://www.github.com/owner/repo) now',
  );
});

test('linkifyMarkdown: title/url escaping for ) and ]', () => {
  const out = linkifyMarkdown('x https://e.com/a)b now');
  // `)` is valid inside link text, so the title keeps it; only the URL
  // destination escapes `)`.
  assert.ok(out.includes('[e.com/a)b](https://e.com/a\\)b)'), 'url destination escapes )');
  assert.ok(!out.includes('[e.com/a\\)b]'), 'title does not escape ) (valid in link text)');
});

// ---- integration: real render ----

test('render: URLs become links in HTML + Markdown; JSON text unchanged', async () => {
  const chat = 'WhatsApp Chat - Link Test';
  const lines = [
    '23/07/2026 09:47 - Owner: check this https://www.github.com/owner/repo?x=1 please',
    '23/07/2026 09:48 - Owner: visit https://example.com/ for docs',
  ].join('\n');
  const zipped = zipSync({ [`${chat}/_chat.txt`]: Buffer.from(lines, 'utf8') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-link-'));
  const zipPath = path.join(tmp, 'link.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-link-out-'));
  await runParser(zipPath, { out, noFetchTitles: true });

  const dir = path.join(out, slugifyChatName(chat));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
  const md = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));

  assert.ok(
    html.includes('<a href="https://www.github.com/owner/repo?x=1"'),
    'HTML anchor href',
  );
  assert.ok(html.includes('github.com/owner/repo</a>'), 'HTML anchor with derived title');
  assert.ok(
    html.includes('<a href="https://example.com/"'),
    'HTML anchor href, root path',
  );
  assert.ok(html.includes('example.com</a>'), 'HTML anchor, root path -> host only');
  assert.ok(html.includes('class="favicon"'), 'HTML anchor has favicon');

  assert.ok(
    md.includes('[github.com/owner/repo](https://www.github.com/owner/repo?x=1)'),
    'MD link with derived title',
  );
  assert.ok(md.includes('[example.com](https://example.com/)'), 'MD link host-only');

  assert.equal(
    json.messages[0].text,
    'check this https://www.github.com/owner/repo?x=1 please',
    'JSON text unchanged',
  );
});

// ---- resolver override ----

test('linkify: resolver overrides the displayed title', () => {
  const out = linkifyHtml('go https://example.com/x', (u) =>
    u.includes('example.com') ? 'Fetched Title' : u,
  );
  assert.ok(out.includes('>Fetched Title</a>'), 'html uses resolver label');
  assert.ok(out.includes('href="https://example.com/x"'), 'href unchanged');
  const md = linkifyMarkdown('go https://example.com/x', () => 'Fetched Title');
  assert.ok(md.includes('[Fetched Title](https://example.com/x)'), 'md uses resolver label');
});

test('linkify: resolver defaults to deriveTitle when omitted', () => {
  const out = linkifyHtml('see https://example.com/path');
  assert.ok(out.includes('>example.com/path</a>'), 'falls back to derived title');
});

test('linkify: iconResolver prepends a favicon img before the title', () => {
  const out = linkifyHtml('go https://example.com/x', undefined, (u) => `https://${new URL(u).host}/favicon.ico`);
  assert.ok(out.includes('class="favicon"'), 'favicon img present');
  assert.ok(out.includes('src="https://example.com/favicon.ico"'), 'favicon src from iconResolver');
  assert.ok(out.includes('>example.com/x</a>'), 'title still shown after favicon');
});

test('linkify: no favicon img when iconResolver empty', () => {
  const out = linkifyHtml('go https://example.com/x', undefined, () => '');
  assert.ok(!out.includes('class="favicon"'), 'no favicon when resolver empty');
});

// ---- LinkedIn redirect unwrapping ----

test('unwrapUrl: decodes LinkedIn /safety/go redirect to the real destination', () => {
  const li =
    'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fsourcecode%2Ekanaiyakatarmal%2Ecom%2FCLAUDE&urlhash=Wh6w&isSdui=true';
  assert.equal(unwrapUrl(li), 'https://sourcecode.kanaiyakatarmal.com/CLAUDE');
});

test('unwrapUrl: passes through non-redirect and profile URLs', () => {
  assert.equal(unwrapUrl('https://example.com/p'), 'https://example.com/p');
  assert.equal(
    unwrapUrl('https://www.linkedin.com/in/john-doe'),
    'https://www.linkedin.com/in/john-doe',
  );
});

test('linkify: LinkedIn redirect href + title use the real destination', () => {
  const li =
    'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fsourcecode%2Ekanaiyakatarmal%2Ecom%2FCLAUDE&urlhash=x';
  const out = linkifyHtml(li, undefined, faviconFor);
  assert.ok(out.includes('href="https://sourcecode.kanaiyakatarmal.com/CLAUDE"'), 'href is real destination');
  assert.ok(out.includes('>sourcecode.kanaiyakatarmal.com/CLAUDE</a>'), 'title from real host');
  assert.ok(out.includes('src="https://sourcecode.kanaiyakatarmal.com/favicon.ico"'), 'favicon of real host');
});

