import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';
import { readCsv } from '../src/csv';
import {
  normalizeMediaName,
  mimeFromExt,
  isInlineable,
  INLINE_MAX_BYTES,
  reconcileMedia,
  buildMediaMap,
} from '../src/media';

const ROOT = process.cwd();
const NOTAS_ZIP = path.join(ROOT, 'fixtures', 'WhatsApp Chat - Notas pessoais.zip');

test('normalizeMediaName: case + (1) + dash/space tolerance', () => {
  assert.equal(
    normalizeMediaName('Photo (1).JPG'),
    normalizeMediaName('photo.jpg'),
  );
  assert.equal(
    normalizeMediaName('IMG 20190424 WA0003.jpg'),
    normalizeMediaName('IMG-20190424-WA0003.jpg'),
  );
  assert.notEqual(
    normalizeMediaName('IMG-20190424-WA0001.jpg'),
    normalizeMediaName('IMG-20190424-WA0002.jpg'),
  );
});

test('mimeFromExt + isInlineable', () => {
  assert.equal(mimeFromExt('.jpg'), 'image/jpeg');
  assert.equal(mimeFromExt('PNG'), 'image/png');
  assert.equal(mimeFromExt('.webp'), 'image/webp');
  assert.equal(mimeFromExt('.mp4'), 'video/mp4');
  assert.equal(mimeFromExt('.pdf'), 'application/pdf');
  assert.equal(mimeFromExt('.xyz'), 'application/octet-stream');
  assert.equal(isInlineable('image/jpeg', 100), true);
  assert.equal(isInlineable('video/mp4', 100), false);
  assert.equal(isInlineable('image/jpeg', INLINE_MAX_BYTES + 1), false);
});

test('reconcileMedia on Notas pessoais sample: 17 resolved, 0 unresolved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-rec-'));
  const slug = 'notas-pessoais';
  const outDir = path.join(dir, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const refs = [
    '00000008-STICKER-2026-04-03-15-17-12.webp',
    '00000021-STICKER-2026-04-10-21-58-01.webp',
    '00000023-STICKER-2026-04-11-13-24-21.webp',
    '00000040-STICKER-2026-04-20-15-16-33.webp',
    '00000045-STICKER-2026-04-23-23-19-31.webp',
    '00000068-Conversa do WhatsApp com Notas pessoais.zip',
    '00000088-STICKER-2026-05-27-08-45-13.webp',
    '00000089-VIDEO-2026-05-27-17-26-38.mp4',
    '00000091-PHOTO-2026-05-29-17-23-37.jpg',
    '00000098-PHOTO-2026-06-10-13-55-47.jpg',
    '00000099-STICKER-2026-06-10-13-55-59.webp',
    '00000134-PHOTO-2026-07-18-22-34-29.jpg',
    '00000147-PHOTO-2026-07-26-19-23-49.jpg',
    '00000148-PHOTO-2026-07-28-07-48-08.jpg',
    '00000149-PHOTO-2026-07-28-07-48-50.jpg',
    '00000152-96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf',
    '00000153-raw.pdf',
  ];
  const res = await reconcileMedia(NOTAS_ZIP, outDir, refs);
  assert.equal(res.resolved.length, 17, 'all 17 refs resolved');
  assert.equal(res.unresolved.length, 0, 'no unresolved refs');
  const files = fs.readdirSync(path.join(outDir, 'media')).sort();
  assert.equal(files.length, 17);
  assert.ok(
    files.includes('00000089-VIDEO-2026-05-27-17-26-38.mp4'),
    'video copied',
  );
  assert.ok(
    files.includes('00000152-96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf'),
    'pdf copied',
  );
});

test('buildMediaMap: resolves disk files tolerant of (1) variance + inlineable flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-map-'));
  // media file stored with a (1) duplicate marker; ref omits it.
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(dir, 'media', 'photo (1).jpg'), pngBytes);
  // A CSV referencing the normalized name (no (1)).
  fs.writeFileSync(
    path.join(dir, 'messages.csv'),
    'timestamp_iso,type,author,text,media\n' +
      '2026-01-01T10:00:00,photo,Me,caption,photo.jpg\n',
  );
  const messages = readCsv(path.join(dir, 'messages.csv'));
  const map = buildMediaMap(dir, messages);
  const entry = map.get('photo.jpg');
  assert.ok(entry, 'ref resolves to the (1)-variant file');
  assert.equal(entry!.relPath, 'media/photo (1).jpg');
  assert.equal(entry!.mime, 'image/jpeg');
  assert.equal(entry!.inlineable, true);
  // Missing-but-expected ref is absent from the map.
  fs.writeFileSync(
    path.join(dir, 'messages.csv'),
    'timestamp_iso,type,author,text,media\n' +
      '2026-01-01T10:00:00,photo,Me,caption,ghost.jpg\n',
  );
  const map2 = buildMediaMap(dir, readCsv(path.join(dir, 'messages.csv')));
  assert.equal(map2.has('ghost.jpg'), false);
});

test('--inline produces data: URIs and skips the video (synthetic)', async () => {
  const chat = 'WhatsApp Chat - Inline Test';
  const txt = [
    '23/07/2026 09:47 - Owner: <attached: IMG-test.png>',
    '23/07/2026 09:48 - Owner: <attached: clip.mp4>',
  ].join('\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const mp4 = Buffer.from([0, 1, 2, 3, 4, 5]);
  const zipped = zipSync({
    [`${chat}/_chat.txt`]: Buffer.from(txt, 'utf8'),
    [`${chat}/IMG-test.png`]: png,
    [`${chat}/clip.mp4`]: mp4,
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-inl-'));
  const zipPath = path.join(tmp, 'inline.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-inl-out-'));
  await runParser(zipPath, { out, inline: true });

  const dir = path.join(out, slugifyChatName(chat));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
  assert.ok(html.includes('src="data:image/png;base64,'), 'png inlined as data URI');
  assert.ok(!html.includes('src="media/IMG-test.png"'), 'png not left as relative link');
  assert.ok(
    html.includes('media-placeholder') && html.includes('clip.mp4'),
    'video stays a placeholder under --inline',
  );
});

test('unresolved media ref: no crash, reported, rendered as placeholder (all 3 outputs)', async () => {
  const chat = 'WhatsApp Chat - Missing Media';
  const txt = '23/07/2026 09:47 - Owner: <attached: does-not-exist.jpg>';
  const zipped = zipSync({ [`${chat}/_chat.txt`]: Buffer.from(txt, 'utf8') });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-miss-'));
  const zipPath = path.join(tmp, 'missing.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mt-miss-out-'));

  const origErr = console.error;
  const errLines: string[] = [];
  console.error = (...a: unknown[]) => errLines.push(a.join(' '));
  let threw = false;
  try {
    await runParser(zipPath, { out });
  } catch {
    threw = true;
  } finally {
    console.error = origErr;
  }
  assert.equal(threw, false, 'run does not throw on unresolved media');
  const stderr = errLines.join('\n');
  assert.ok(stderr.includes('unresolved'), 'reports unresolved on stderr');
  assert.ok(stderr.includes('does-not-exist.jpg'), 'names the missing ref');

  const dir = path.join(out, slugifyChatName(chat));
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  assert.equal(json.messages[0].media, 'does-not-exist.jpg');
  assert.equal(json.messages[0].mediaPath, null, 'missing -> mediaPath null');
  const md = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
  assert.ok(
    /\[[^\]]*does-not-exist\.jpg\]/.test(md),
    'MD keeps bracket placeholder (no link)',
  );
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
  assert.ok(
    html.includes('<span class="media-placeholder">') &&
      html.includes('does-not-exist.jpg'),
    'HTML shows placeholder',
  );
  assert.ok(
    !html.includes('<img src="media/does-not-exist.jpg">'),
    'no broken <img> for missing media',
  );
});
