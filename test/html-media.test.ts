import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const NOTAS = 'WhatsApp Chat - Notas pessoais';

async function renderNotas(out: string): Promise<string> {
  await runParser(path.join(ROOT, 'fixtures', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  return fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
}

test('html: photo/sticker imgs get media-img class + thumbnail css', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-html-'));
  const html = await renderNotas(out);

  const imgTags = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  const mediaImgs = imgTags.filter((t) => t.includes('class="media-img"'));
  assert.ok(mediaImgs.length > 0, 'expected at least one .media-img');

  // Every <img> is a media thumbnail, a link favicon, or the (empty) lightbox img.
  for (const t of imgTags) {
    if (t.includes('class="media-img"')) continue;
    if (t.includes('class="favicon"')) continue;
    assert.ok(t.trim() === '<img alt="">', `unexpected <img>: ${t}`);
  }

  assert.ok(html.includes('.media-img'), 'css .media-img rule present');
  assert.ok(/max-width:\s*220px/.test(html), 'thumbnail max-width present');
  assert.ok(/max-height:\s*280px/.test(html), 'thumbnail max-height present');
});

test('html: lightbox container + classic (non-module) script present', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-html-lb-'));
  const html = await renderNotas(out);

  assert.ok(
    html.includes('<div class="lightbox" id="lightbox">'),
    'lightbox container present',
  );

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const lb = scripts.find(
    (s) => s[2].includes("getElementById('lightbox')") && s[2].includes("classList.add('open')"),
  );
  assert.ok(lb, 'lightbox handler script found');
  assert.ok(!/type="module"/.test(lb[1]), 'lightbox script is NOT a module');
  assert.ok(html.includes('.lightbox {'), 'css .lightbox rule present');
  assert.ok(html.includes('.lightbox.open'), 'css .lightbox.open rule present');
});

test('transcript.js: renders real img when mediaPath present, placeholder otherwise', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/js/transcript.js'), 'utf8');
  assert.ok(src.includes("img.className = 'media-img'"), 'renders .media-img img');
  assert.ok(src.includes('img.src = m.mediaPath'), 'uses m.mediaPath for src');
  assert.ok(src.includes('media-placeholder'), 'still falls back to placeholder');
});
