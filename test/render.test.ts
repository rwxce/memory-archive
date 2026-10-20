import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';
import { toRendered } from '../src/render/json';
import { renderMarkdown } from '../src/render/md';
import { renderHtml } from '../src/render/html';
import { csvRow } from '../src/csv';
import type { Message } from '../src/parse/types';

const ROOT = process.cwd();
const WK = 'WhatsApp Chat - Plataforma WK';
const NOTAS = 'WhatsApp Chat - Notas pessoais';

async function runFixture(chat: string, out: string): Promise<void> {
  const txt = fs.readFileSync(path.join(ROOT, 'fixtures', chat, '_chat.txt'));
  const files: Record<string, Uint8Array> = { [`${chat}/_chat.txt`]: txt };
  // Include the real media folder when present so renderers can resolve it.
  const mediaDir = path.join(ROOT, 'fixtures', chat);
  if (fs.existsSync(mediaDir)) {
    for (const f of fs.readdirSync(mediaDir)) {
      if (f.startsWith('._') || f === '_chat.txt') continue;
      files[`${chat}/${f}`] = fs.readFileSync(path.join(mediaDir, f));
    }
  }
  const zipped = zipSync(files);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-render-'));
  const zipPath = path.join(tmp, 'export.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  fs.mkdirSync(out, { recursive: true });
  await runParser(zipPath, { out });
}

function outDirFor(out: string, chat: string): string {
  return path.join(out, slugifyChatName(chat));
}

function readJson(out: string, chat: string) {
  return JSON.parse(
    fs.readFileSync(path.join(outDirFor(out, chat), 'messages.json'), 'utf8'),
  );
}

test('WK: JSON envelope structure and metadata', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-json-'));
  await runFixture(WK, out);
  const env = readJson(out, WK);

  assert.equal(env.metadata.chatName, 'Plataforma WK');
  assert.equal(typeof env.metadata.messageCount, 'number');
  assert.ok(env.metadata.messageCount > 0);
  assert.deepEqual(env.metadata.dateRange, ['2026-07-23', '2026-08-20']);
  assert.equal(env.metadata.exportSource, 'whatsapp-export');

  const first = env.messages[0];
  for (const k of ['timestampIso', 'type', 'author', 'text', 'media', 'day', 'time']) {
    assert.ok(k in first, `missing field ${k}`);
  }
  assert.equal(first.day, '2026-07-23');
  assert.equal(first.time, '09:47:18');
});

test('WK: message count matches CSV row count', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-json2-'));
  await runFixture(WK, out);
  const env = readJson(out, WK);
  const csv = fs
    .readFileSync(path.join(outDirFor(out, WK), 'messages.csv'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(env.metadata.messageCount, csv.length - 1);
});

test('WK: Markdown day sections, format, media, deleted', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-md-'));
  await runFixture(WK, out);
  const md = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.md'), 'utf8');

  assert.ok(md.includes('## 23 de julho de 2026'), 'pt-BR day section');
  assert.ok(
    md.includes(
      '**Plataforma WK** · 09:47 — Messages and calls are end-to-end encrypted',
    ),
    'first message format',
  );
  assert.ok(
    md.includes('![00003010-STICKER-2026-07-23-12-41-49.webp](media/00003010-STICKER-2026-07-23-12-41-49.webp)'),
    'sticker embedded as Markdown image',
  );
  assert.ok(md.includes('*Mensagem apagada*'), 'deleted message italic');
});

test('WK: Markdown messages are separated by blank lines (no merge)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-md-sep-'));
  await runFixture(WK, out);
  const md = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.md'), 'utf8');
  const lines = md.split('\n');
  const headers = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => /\*\*.*\*\* · \d{2}:\d{2} — /.test(x.l));
  assert.ok(headers.length >= 2, 'multiple message headers present');
  for (let k = 1; k < headers.length; k++) {
    assert.ok(
      headers[k].i - headers[k - 1].i >= 2,
      `message headers must have a blank line between them (found adjacent at line ${headers[k].i + 1})`,
    );
  }
});

test('Notas: deleted + document-omitted render in Markdown', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-md2-'));
  await runFixture(NOTAS, out);
  const md = fs.readFileSync(path.join(outDirFor(out, NOTAS), 'messages.md'), 'utf8');

  assert.ok(md.includes('*Mensagem apagada*'), 'deleted');
  assert.ok(
    md.includes('*document omitted*') || md.includes('autorizacao_atividade.pdf'),
    'document omitted marker preserved',
  );
});

test('WK: HTML shell has data island, toolbar, theme toggle, day-pill', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-html-'));
  await runFixture(WK, out);
  const html = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.html'), 'utf8');

  assert.ok(html.includes('<script type="application/json" id="chat-data">'), 'data island');
  assert.ok(html.includes('id="toolbar"'), 'toolbar');
  assert.ok(html.includes('class="day-pill"'), 'day-pill class in CSS');
  assert.ok(html.includes('id="theme-toggle"'), 'theme toggle');
  assert.ok(html.includes('function populateTranscript'), 'populateTranscript defined');
  assert.ok(html.includes('textContent'), 'textContent usage');
  assert.ok(
    html.includes('class="media-img"') &&
      html.includes('00003010-STICKER-2026-07-23-12-41-49.webp'),
    'media rendered as resolved <img> (not placeholder)',
  );
});

test('XSS: adversarial content renders inert in all three outputs (OUT-05)', async () => {
  const chat = 'WhatsApp Chat - XSS Test';
  const lines = [
    '23/07/2026 09:47 - Owner: <script>alert("xss")</script>',
    '23/07/2026 09:48 - Owner: <img src=x onerror="alert(1)">',
    '23/07/2026 09:49 - Owner: javascript:alert(1)',
    '23/07/2026 09:50 - Owner: Normal message',
  ].join('\n');
  const zipped = zipSync({ [`${chat}/_chat.txt`]: Buffer.from(lines, 'utf8') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-xss-'));
  const zipPath = path.join(tmp, 'xss.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-xss-out-'));
  await runParser(zipPath, { out });

  const dir = path.join(out, slugifyChatName(chat));
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  const md = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  // JSON keeps the raw (but safely-quoted) string.
  assert.equal(json.messages[0].text, '<script>alert("xss")</script>');

  // Markdown escapes HTML.
  assert.ok(md.includes('&lt;script&gt;alert'), 'MD escapes <script>');
  assert.ok(!md.includes('<script>alert'), 'MD has no raw <script>');

  // HTML: server-rendered bubble text escaped; the data island never breaks out.
  assert.ok(html.includes('&lt;script&gt;alert'), 'HTML escapes <script> in bubbles');
  // The adversarial message's closing tag is escaped (</ -> <\/), so the raw
  // payload `<script>alert("xss")</script>` must NOT appear literally.
  assert.ok(
    !html.includes('<script>alert("xss")</script>'),
    'adversarial </script> is escaped, not literal',
  );
  assert.ok(html.includes('<\\/script>'), 'island escapes </ to <\\/');
  // No executable javascript: href.
  assert.ok(!/href\s*=\s*["']?\s*javascript:/i.test(html), 'no javascript: href');
});

test('HTML: per-sender accent color is deterministic and distinct', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-color-'));
  await runFixture(WK, out);
  const html = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.html'), 'utf8');
  // Same author hue is consistent; find two distinct author colors.
  const hues = [...html.matchAll(/color:hsl\((\d+), 70%, 60%\)/g)].map((m) => m[1]);
  assert.ok(hues.length >= 2, 'multiple accent colors applied');
  assert.notEqual(hues[0], hues[1], 'distinct senders map to distinct hues');
});

test('WK: chat title shown in HTML header and Markdown H1', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-title-'));
  await runFixture(WK, out);
  const html = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.html'), 'utf8');
  const md = fs.readFileSync(path.join(outDirFor(out, WK), 'messages.md'), 'utf8');

  assert.ok(
    html.includes('id="chat-title"') && html.includes('Plataforma WK'),
    'HTML header shows chat title',
  );
  assert.ok(md.startsWith('# Plataforma WK'), 'Markdown starts with chat title H1');
});

test('JSON: message carries urlTitles map', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jsonurl-'));
  await runFixture(WK, out);
  const env = readJson(out, WK);
  const withUrl = env.messages.find((m) => m.text && /https?:\/\//.test(m.text));
  // WK sample has no URLs; assert the field exists and is an object.
  assert.ok(
    withUrl === undefined || (withUrl.urlTitles && typeof withUrl.urlTitles === 'object'),
    'urlTitles present as object',
  );
  // Unit-check toRendered maps it through.
  const r = toRendered({
    timestamp_iso: '2026-07-23T09:47:18',
    type: 'text',
    author: 'a',
    text: 'x',
    media: '',
    urlTitles: { u: 'T' },
  });
  assert.deepEqual(r.urlTitles, { u: 'T' });
});

test('render: link label uses stored urlTitles when present', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-linkurl-'));
  await runFixture(WK, out);
  const dir = outDirFor(out, WK);
  // Hand-write a CSV row with a URL + url_titles, then re-render md/html.
  const csv = path.join(dir, 'messages.csv');
  const rows = fs.readFileSync(csv, 'utf8').trimEnd().split('\n');
  const extra: Message = {
    timestamp_iso: '2026-08-01T10:00:00',
    type: 'text',
    author: 'Guionardo',
    text: 'visit https://example.com/foo',
    media: '',
    urlTitles: { 'https://example.com/foo': 'Example Foo' },
  };
  rows.push(csvRow(extra).trimEnd());
  fs.writeFileSync(csv, rows.join('\n') + '\n');
  await renderMarkdown(csv, dir, 'WK', {});
  await renderHtml(csv, dir, 'WK', {});
  const md = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
  assert.ok(md.includes('[Example Foo](https://example.com/foo)'), 'md uses stored title');
  assert.ok(html.includes('>Example Foo</a>'), 'html uses stored title');
});
