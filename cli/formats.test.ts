import { describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { FORMAT_FIXTURES } from '../scripts/generate-fixtures.mjs';
import { runParser } from './pipeline';
import { readCsv } from './csv';

const FIXTURES = path.join(process.cwd(), 'fixtures');

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe.each(FORMAT_FIXTURES.map((f) => [f.zip, f] as const))('%s through the CLI', (zip, fixture) => {
  test('all referenced media resolve and are copied; a second run adds nothing', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-fmt-'));
    const err = quiet();
    try {
      const zipPath = path.join(FIXTURES, zip);
      const added = await runParser(zipPath, { out });
      expect(added).toBeGreaterThan(0);
      const stderr = err.mock.calls.flat().join('\n');
      expect(stderr).not.toContain('unresolved:');

      const [dir] = fs.readdirSync(out);
      const copied = fs.existsSync(path.join(out, dir, 'media'))
        ? fs.readdirSync(path.join(out, dir, 'media')).sort()
        : [];
      expect(copied).toEqual([...fixture.media].sort());

      expect(await runParser(zipPath, { out })).toBe(0);
      expect(readCsv(path.join(out, dir, 'messages.csv'))).toHaveLength(added);
    } finally {
      err.mockRestore();
    }
  });
});

test('identical same-minute messages: both kept, re-import adds 0, a newer export with a third adds 1', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-dup-'));
  const err = quiet();
  try {
    const original = path.join(FIXTURES, 'WhatsApp Chat - Android US.zip');
    await runParser(original, { out });
    const csvPath = path.join(out, 'android-us', 'messages.csv');
    const oks = () => readCsv(csvPath).filter((m) => m.text === 'ok');
    expect(oks()).toHaveLength(2);
    expect(await runParser(original, { out })).toBe(0);

    // A newer export of the same chat: one more "ok" in the same minute.
    const files = unzipSync(fs.readFileSync(original));
    const txt = new TextDecoder().decode(files['_chat.txt']).replace(
      '1/1/26, 12:30 PM - Ana Lima: ok\n',
      '1/1/26, 12:30 PM - Ana Lima: ok\n1/1/26, 12:30 PM - Ana Lima: ok\n',
    );
    const newer = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-dup-zip-')), 'WhatsApp Chat - Android US.zip');
    fs.writeFileSync(newer, zipSync({ ...files, '_chat.txt': strToU8(txt) }));
    expect(await runParser(newer, { out })).toBe(1);
    expect(oks()).toHaveLength(3);
  } finally {
    err.mockRestore();
  }
});
