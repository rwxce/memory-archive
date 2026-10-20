import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { encodePng, OUTPUTS, renderIcon, renderSvg } from './generate-icons.mjs';

/** RGBA pixels of an 8-bit RGBA, filter-0 PNG written by `encodePng`. */
function decodePixels(png: Buffer): { size: number; rgba: Uint8Array } {
  const size = png.readUInt32BE(16);
  const chunks: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    expect(raw[y * (size * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1)), y * size * 4);
  }
  return { size, rgba };
}

describe('generate-icons', () => {
  // Compared by pixels, not bytes: zlib builds differ between Node versions,
  // so the same pixels can deflate to different (equally valid) PNG bytes.
  test('committed icons match the generator (run `pnpm icons` when this fails)', () => {
    expect(fs.readFileSync('app/icon.svg', 'utf8')).toBe(renderSvg());
    for (const o of OUTPUTS) {
      const { size, rgba } = decodePixels(fs.readFileSync(o.file));
      expect(size, o.file).toBe(o.size);
      const expected = renderIcon(o.size, o);
      let worst = 0;
      for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(expected[i] - rgba[i]));
      expect(worst, `${o.file} is stale`).toBeLessThanOrEqual(1);
    }
  });

  test('encodePng round-trips pixels', () => {
    const rgba = renderIcon(8, { rounded: true, inset: 1 });
    const { size, rgba: back } = decodePixels(encodePng(8, rgba));
    expect(size).toBe(8);
    expect([...back]).toEqual([...rgba]);
  });

  test('maskable and apple icons are full bleed (opaque corners); "any" icons are rounded', () => {
    for (const o of OUTPUTS) expect(renderIcon(o.size, o)[3], o.file).toBe(o.rounded ? 0 : 255);
  });
});
