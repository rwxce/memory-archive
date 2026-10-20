import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  dedupeKey,
  mergeCsv,
  readCsv,
  writeCsv,
} from '../src/csv';
import type { Message } from '../src/parse/types';

function msg(
  timestamp_iso: string,
  type: Message['type'],
  author: string,
  text: string,
  media = '',
): Message {
  return { timestamp_iso, type, author, text, media };
}

function tmpCsv(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-csv-')), 'messages.csv');
}

test('dedupeKey joins with 0x1F — field collisions impossible', () => {
  const a = msg('2026-01-01T00:00:00', 'text', 'A,B', 'C');
  const b = msg('2026-01-01T00:00:00', 'text', 'A', 'B,C');
  assert.notEqual(dedupeKey(a), dedupeKey(b));
});

test('mergeCsv same messages twice => no duplicates (D-16)', async () => {
  const file = tmpCsv();
  const rows = [
    msg('2026-07-23T09:47:18', 'text', 'A', 'hello'),
    msg('2026-07-23T09:47:19', 'photo', 'A', '', 'x.jpg'),
  ];
  await writeCsv(file, rows);
  const added = await mergeCsv(file, rows);
  assert.equal(added, 0);
  assert.equal(readCsv(file).length, 2);
});

test('mergeCsv adds only new rows; duplicate skipped', async () => {
  const file = tmpCsv();
  const existing = [msg('2026-07-23T10:00:00', 'text', 'A', 'one')];
  await writeCsv(file, existing);

  const added = await mergeCsv(file, [
    msg('2026-07-23T11:00:00', 'text', 'B', 'two'),
    msg('2026-07-23T12:00:00', 'text', 'C', 'three'),
    msg('2026-07-23T13:00:00', 'text', 'D', 'four'),
    msg('2026-07-23T10:00:00', 'text', 'A', 'one'), // duplicate
  ]);

  assert.equal(added, 3);
  const all = readCsv(file);
  assert.equal(all.length, 4);
});

test('mergeCsv sorts ascending; equal timestamps keep insertion order (D-17)', async () => {
  const file = tmpCsv();
  await writeCsv(file, [
    msg('2026-07-24T10:41:10', 'photo', 'A', '', 'first.jpg'),
    msg('2026-07-24T10:41:10', 'photo', 'A', '', 'second.jpg'),
    msg('2026-07-24T09:00:00', 'text', 'B', 'earlier'),
  ]);
  await mergeCsv(file, [msg('2026-07-24T08:00:00', 'text', 'C', 'earliest')]);

  const all = readCsv(file);
  assert.deepEqual(
    all.map((m) => m.timestamp_iso),
    [
      '2026-07-24T08:00:00',
      '2026-07-24T09:00:00',
      '2026-07-24T10:41:10',
      '2026-07-24T10:41:10',
    ],
  );
  assert.equal(all[2].media, 'first.jpg');
  assert.equal(all[3].media, 'second.jpg');
});

test('merged file keeps header + no BOM (D-19)', async () => {
  const file = tmpCsv();
  await mergeCsv(file, [msg('2026-01-01T00:00:00', 'text', 'A', 'x')]);
  const raw = fs.readFileSync(file);
  assert.equal(raw.toString('utf8').split('\n')[0], 'timestamp_iso,type,author,text,media,url_titles');
  assert.equal(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
});

test('G-01-4: CR/LF escaped — one physical line per row, lossless round-trip', async () => {
  const file = tmpCsv();
  const rows = [
    msg('2026-07-23T14:56:14', 'text', 'A', 'Rede: X\nSenha: Y'),
    msg('2026-07-23T15:00:00', 'text', 'B', 'back\\slash and\nnewline'),
    msg('2026-07-23T16:00:00', 'text', 'C', 'tricky \\n literal'),
  ];
  await writeCsv(file, rows);

  // One physical line per row + header (trailing \n on last row).
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.split('\n').length - 1, rows.length + 1);

  // Round-trip: readCsv restores the exact original strings (plus the
  // always-present empty urlTitles map).
  const back = readCsv(file);
  assert.deepEqual(
    back,
    rows.map((r) => ({ ...r, urlTitles: {} })),
  );
});

test('G-01-4: merge re-write keeps escaping stable (write->read->write)', async () => {
  const file = tmpCsv();
  await writeCsv(file, [msg('2026-01-01T00:00:00', 'text', 'A', 'x\ny')]);
  await mergeCsv(file, [msg('2026-01-02T00:00:00', 'text', 'B', 'p\\q')]);
  const back = readCsv(file);
  assert.equal(back[0].text, 'x\ny');
  assert.equal(back[1].text, 'p\\q');
});

test('url_titles: round-trips as a JSON map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-csvurl-'));
  const p = path.join(dir, 'messages.csv');
  const m: Message = {
    timestamp_iso: '2026-07-23T09:47:18',
    type: 'text',
    author: 'Guionardo',
    text: 'see https://example.com/page',
    media: '',
    urlTitles: { 'https://example.com/page': 'Example Page' },
  };
  await writeCsv(p, [m]);
  const back = readCsv(p);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].urlTitles, { 'https://example.com/page': 'Example Page' });
});

test('url_titles: legacy 5-column row parses with empty urlTitles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-csvurl2-'));
  const p = path.join(dir, 'messages.csv');
  fs.writeFileSync(
    p,
    'timestamp_iso,type,author,text,media\n2026-07-23T09:47:18,text,Guionardo,hi,\n',
  );
  const back = readCsv(p);
  assert.deepEqual(back[0].urlTitles, {});
});
