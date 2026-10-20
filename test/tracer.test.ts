import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const SAMPLES = [
  'WhatsApp Chat - Plataforma WK',
  'WhatsApp Chat - Notas pessoais',
];

/** Minimal RFC-4180 reader: returns records of 5 fields each. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n') {
      record.push(field);
      field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  return records;
}

function buildZip(chat: string): string {
  const txt = fs.readFileSync(path.join(ROOT, 'fixtures', chat, '_chat.txt'));
  const zipped = zipSync({ [`${chat}/_chat.txt`]: txt });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-'));
  const zipPath = path.join(tmp, 'export.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  return zipPath;
}

async function parseSample(chat: string): Promise<string[][]> {
  const zip = buildZip(chat);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-out-'));
  await runParser(zip, { out });
  return parseCsv(fs.readFileSync(path.join(out, slugifyChatName(chat), 'messages.csv'), 'utf8'));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

test('Plataforma WK: header + no BOM + ISO timestamps', async () => {
  const zip = buildZip(SAMPLES[0]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-out-'));
  await runParser(zip, { out });

  const csvPath = path.join(out, slugifyChatName(SAMPLES[0]), 'messages.csv');
  const raw = fs.readFileSync(csvPath);
  assert.equal(
    raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    false,
    'CSV must not have a BOM',
  );

  const text = raw.toString('utf8');
  assert.equal(text.split('\n')[0], 'timestamp_iso,type,author,text,media,url_titles');

  for (const rec of parseCsv(text).slice(1)) {
    assert.equal(rec.length, 6, `row must have 6 fields: ${rec[0]}`);
    assert.match(rec[0], ISO_RE, `timestamp must be local ISO, got: ${rec[0]}`);
    assert.doesNotMatch(rec[0], /Z|[+-]\d{2}:?\d{2}$/, 'no timezone allowed');
  }
});

test('Plataforma WK: core rows extracted correctly', async () => {
  const records = await parseSample(SAMPLES[0]);

  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-07-23T09:47:18' &&
        r[1] === 'text' &&
        r[2] === 'Plataforma WK' &&
        r[3] ===
          'Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.' &&
        r[4] === '',
    ),
    'line 1 (encrypted notice)',
  );

  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-07-23T12:41:48' &&
        r[1] === 'sticker' &&
        r[2] === 'Guionardo Furlan' &&
        r[3] === '' &&
        r[4] === '00003010-STICKER-2026-07-23-12-41-49.webp',
    ),
    'line 10 (sticker, empty text)',
  );

  // Empty-body -> attachment merge: ONE photo row, NO phantom empty row.
  assert.ok(
    records.some(
      (r) =>
        r[1] === 'photo' &&
        r[2] === 'Camilla Araujo WK' &&
        r[3] === '' &&
        r[4] === '00003036-PHOTO-2026-07-23-23-31-30.jpg',
    ),
    'lines 36-37 merged into a single photo row',
  );
  assert.ok(
    !records.some(
      (r) => r[0] === '2026-07-23T23:31:29' && r[3] === '' && r[4] === '',
    ),
    'no phantom empty-text row at 23:31:29',
  );

  // Same-second burst: 5 distinct Gian Carlo photo rows.
  const gianSrc = fs
    .readFileSync(path.join(ROOT, 'fixtures', SAMPLES[0], '_chat.txt'), 'utf8')
    .split('\n')
    .find((l) => l.includes('00003046'))!;
  const gianAuthor = gianSrc.match(/\] (.+?):/)?.[1] ?? '';
  const burst = records.filter(
    (r) => r[1] === 'photo' && r[2] === gianAuthor && r[0].startsWith('2026-07-24T10:41'),
  );
  assert.equal(burst.length, 5, 'five same-second burst rows');
  assert.equal(
    new Set(burst.map((r) => r[4])).size,
    5,
    'burst rows have distinct media filenames',
  );

  // Continuation join: Senha line folded into the Rede row.
  const contRow = records.find((r) => r[3].includes('Senha: TIMEWK2026'));
  assert.ok(contRow, 'continuation row exists');
  assert.ok(contRow![3].includes('Rede: Conexão WK - Staff'), 'joined with \\n');
  // G-01-4: embedded newline is ESCAPED — every row stays ONE physical line.
  assert.ok(
    contRow![3].includes('Rede: Conexão WK - Staff\\nSenha: TIMEWK2026'),
    'newline written as literal \\n escape',
  );
  for (const r of records) {
    for (const f of r) {
      assert.ok(
        !f.includes('\n') && !f.includes('\r'),
        `raw line break leaked into field: ${JSON.stringify(f.slice(0, 40))}`,
      );
    }
  }
  assert.ok(!records.some((r) => r[3] === 'Senha: TIMEWK2026'), 'no separate Senha row');

  // Raw bidi author preserved verbatim.
  const src = fs
    .readFileSync(path.join(ROOT, 'fixtures', SAMPLES[0], '_chat.txt'), 'utf8')
    .split('\n')
    .find((l) => l.includes('99951'))!;
  const rawAuthor = src.match(/\] (.+?): /)![1];
  assert.ok(
    records.some((r) => r[0] === '2026-07-23T12:15:28' && r[2] === rawAuthor),
    'bidi-wrapped phone author preserved raw',
  );
});

test('Notas pessoais: header, first row, sticker, caption+attachment', async () => {
  const records = await parseSample(SAMPLES[1]);

  assert.ok(records[0], 'has rows');
  assert.ok(
    records.some(
      (r) => r[0] === '2026-03-17T13:17:59' && r[3] === 'https://lefthook.dev/',
    ),
    'first row',
  );
  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-04-03T15:17:12' &&
        r[1] === 'sticker' &&
        r[4] === '00000008-STICKER-2026-04-03-15-17-12.webp',
    ),
    'sticker row (line 37)',
  );
  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-05-29T17:23:37' &&
        r[1] === 'photo' &&
        r[3] === 'Taxa João Furlan' &&
        r[4] === '00000091-PHOTO-2026-05-29-17-23-37.jpg',
    ),
    'caption + attachment row (line 124): caption kept, media set',
  );
});

test('no phantom empty row precedes any media row (both samples)', async () => {
  for (const chat of SAMPLES) {
    const records = await parseSample(chat);
    for (let i = 0; i < records.length; i++) {
      const [ts, , author, text, media] = records[i];
      if (text === '' && media === '') {
        const next = records[i + 1];
        assert.ok(
          !(next && next[2] === author && next[4] !== ''),
          `phantom empty row at ${ts} for ${author}`,
        );
      }
    }
  }
});
