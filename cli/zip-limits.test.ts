import { afterAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { runParser } from './pipeline';
import { reconcileMedia } from './media';
import { CLI_ZIP_LIMITS, chatInfoFromZip } from './zip';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-zip-limits-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CHAT = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:20:00] Ana: <attached: 00000001-PHOTO-2026-03-17-13-20-00.jpg>',
].join('\n');
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';

function write(name: string, bytes: Uint8Array): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Overwrite the declared uncompressed size of one entry in the central directory. */
function declareSize(zip: Uint8Array, entryName: string, uncompressed: number): Uint8Array {
  const bytes = new Uint8Array(zip);
  const view = new DataView(bytes.buffer);
  let eocd = bytes.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLength = view.getUint16(at + 28, true);
    if (new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)) === entryName) {
      view.setUint32(at + 24, uncompressed, true);
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return bytes;
}

const noise = (n: number) => new Uint8Array(n).map((_, i) => (i * 7919) % 251);
const legit = () => zipSync({ '_chat.txt': strToU8(CHAT), [PHOTO]: [noise(4000), { level: 0 }] });

describe('the CLI refuses zip bombs and lying ZIPs with a clear error', () => {
  test('a legitimate export still imports, with media', async () => {
    const out = path.join(tmp, 'out-ok');
    const zip = write('ok.zip', legit());
    expect(await runParser(zip, { out })).toBe(2);
    expect(fs.readdirSync(path.join(out, 'ok', 'media'))).toEqual([PHOTO]);
  });

  test('an extreme compression ratio (zeros) is rejected before anything is written', async () => {
    const bomb = write('bomb.zip', zipSync({ '_chat.txt': strToU8(CHAT), [PHOTO]: new Uint8Array(5_000_000) }));
    const out = path.join(tmp, 'out-bomb');
    await expect(runParser(bomb, { out })).rejects.toThrow(/zip bomb/);
    expect(fs.existsSync(out)).toBe(false);
    await expect(chatInfoFromZip(bomb)).rejects.toThrow(/zip bomb/);
    await expect(reconcileMedia(bomb, path.join(tmp, 'media-bomb'), [PHOTO])).rejects.toThrow(/zip bomb/);
  });

  test('a tiny entry that declares gigabytes is rejected', async () => {
    const lying = write('lying.zip', declareSize(zipSync({ '_chat.txt': strToU8(CHAT), 'x.bin': strToU8('tiny') }), 'x.bin', 0xfffffff0));
    await expect(runParser(lying, { out: path.join(tmp, 'out-lying') })).rejects.toThrow(/zip bomb|larger than allowed/);
  });

  test('a stored entry that declares more than it holds fails when read', async () => {
    const lying = write('short.zip', declareSize(legit(), PHOTO, 6000));
    await expect(reconcileMedia(lying, path.join(tmp, 'media-short'), [PHOTO])).rejects.toThrow(/smaller than it declares/);
  });

  test('the limits are the restore limits', () => {
    expect(CLI_ZIP_LIMITS).toMatchObject({ maxEntries: 200_000, maxCompressionRatio: 100, maxEntryBytes: 4 * 1024 ** 3 });
  });
});
