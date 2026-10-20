import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const CHAT = 'WhatsApp Chat - Notas pessoais';

function parseSample(chat = CHAT): string[][] {
  const txt = fs.readFileSync(path.join(ROOT, 'fixtures', chat, '_chat.txt'));
  const zipped = zipSync({ [`${chat}/_chat.txt`]: txt });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cls-'));
  const zipPath = path.join(tmp, 'export.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipped));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cls-out-'));
  // runParser is async — tests below await a pre-built promise instead.
  return { zipPath, out } as unknown as string[][];
}

/** Minimal RFC-4180 reader (records of fields). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') {
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else if (c !== '\r') field += c;
  }
  return records;
}

async function loadRecords(): Promise<string[][]> {
  const { zipPath, out } = parseSample() as unknown as { zipPath: string; out: string };
  await runParser(zipPath, { out });
  return parseCsv(fs.readFileSync(path.join(out, slugifyChatName(CHAT), 'messages.csv'), 'utf8')).slice(1);
}

test('Notas: omitted/deleted/system/document types (PARSE-07)', async () => {
  const records = await loadRecords();

  // Line 6: `image omitted` -> omitted, marker preserved as text.
  assert.ok(
    records.some(
      (r) => r[0] === '2026-03-20T16:20:22' && r[1] === 'omitted' && r[3].includes('image omitted'),
    ),
    'line 6 image omitted',
  );

  // Line 14: `Mensagem apagada` -> deleted.
  assert.ok(
    records.some(
      (r) => r[0] === '2026-03-25T19:52:16' && r[1] === 'deleted' && r[3] === 'Mensagem apagada',
    ),
    'line 14 deleted',
  );

  // Line 15: `sticker omitted` -> omitted.
  assert.ok(
    records.some(
      (r) => r[0] === '2026-03-25T19:52:29' && r[1] === 'omitted' && r[3].includes('sticker omitted'),
    ),
    'line 15 sticker omitted',
  );

  // Line 18: document-omitted with caption — full marker preserved.
  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-03-28T07:15:45' &&
        r[1] === 'omitted' &&
        r[3].includes('autorizacao_atividade.pdf') &&
        r[3].includes('document omitted') &&
        r[4] === '',
    ),
    'line 18 document omitted w/ caption',
  );

  // Line 196: pdf attachment with leading caption -> document + media + caption.
  // The U+200E before "1 página" is mid-body and MUST be preserved (D-09/PARSE-05).
  assert.ok(
    records.some(
      (r) =>
        r[0] === '2026-07-30T21:44:36' &&
        r[1] === 'document' &&
        r[3] === '96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf • \u200e1 página' &&
        r[4].startsWith('00000152-96980389904-IRPF'),
    ),
    'line 196 pdf attachment + caption',
  );
});

test('Notas: every type value is one of the locked 8 (D-15)', async () => {
  const records = await loadRecords();
  const allowed = new Set([
    'text', 'photo', 'video', 'sticker', 'document', 'system', 'deleted', 'omitted',
  ]);
  for (const r of records) {
    assert.ok(allowed.has(r[1]), `type must be one of the 8: ${r[1]} @ ${r[0]}`);
  }
});

test('Notas: author column is byte-for-byte the raw sender (D-09)', async () => {
  const src = fs
    .readFileSync(path.join(ROOT, 'fixtures', CHAT, '_chat.txt'), 'utf8')
    .split('\n');
  const records = await loadRecords();

  // For each parsed row, recompute what the raw sender was on its source line.
  const rawAuthors = new Set<string>();
  for (const line of src) {
    const afterTs = line.replace(/^[\u200E\uFEFF]*\[[^\]]*\]\s*/, '');
    const m = afterTs.match(/^(.+?):(?:\s|$)/);
    if (m && !/^https?$/.test(m[1])) rawAuthors.add(m[1]);
  }

  for (const r of records) {
    if (r[2] !== '') {
      assert.ok(
        rawAuthors.has(r[2]),
        `author not raw source string: ${JSON.stringify(r[2])}`,
      );
    }
  }
});
