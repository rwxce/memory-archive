import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { encodePng, generateAll, OUTPUTS, renderIcon } from './generate-icons.mjs';

describe('generate-icons', () => {
  test('committed icons are up to date with the generator', () => {
    for (const [file, data] of Object.entries(generateAll())) {
      expect(Buffer.compare(fs.readFileSync(file), Buffer.from(data)), `${file} is stale: run node scripts/generate-icons.mjs`).toBe(0);
    }
  });

  test('PNGs have the declared size and decode back to the rendered pixels', () => {
    for (const o of OUTPUTS) {
      const png = fs.readFileSync(o.file);
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(o.size);
      expect(png.readUInt32BE(20)).toBe(o.size);
    }
    const rgba = renderIcon(8, { rounded: false, inset: 1 });
    const png = encodePng(8, rgba);
    const idat = png.indexOf('IDAT');
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect(raw[0]).toBe(0);
    expect([...raw.subarray(1, 33)]).toEqual([...rgba.subarray(0, 32)]);
  });

  test('maskable and apple icons are full bleed (opaque corners); "any" icons are rounded', () => {
    const corner = (o: (typeof OUTPUTS)[number]) => renderIcon(o.size, o)[3];
    for (const o of OUTPUTS) expect(corner(o), o.file).toBe(o.rounded ? 0 : 255);
  });
});
