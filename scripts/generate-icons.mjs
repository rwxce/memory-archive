// App icons, generated from code: a book with a heart on a warm brown tile.
// No image tools, no downloads — a tiny PNG encoder (node:zlib) and signed
// distance functions, plus the matching SVG. Output is deterministic and
// committed; `generate-icons.test.ts` fails when it is stale.
//
//   node scripts/generate-icons.mjs
//
// Writes:
//   app/icon.svg                     <link rel="icon"> (Next.js file convention)
//   app/apple-icon.png    180×180    apple-touch-icon (full bleed; iOS rounds it)
//   public/icons/icon-192.png        manifest "any"
//   public/icons/icon-512.png        manifest "any"
//   public/icons/icon-maskable-512.png  manifest "maskable" (content in the safe zone)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

export const BRAND = { tile: [0x7f, 0x4e, 0x38], ink: [0xfb, 0xf8, 0xf3] };
export const BRAND_HEX = { tile: '#7f4e38', ink: '#fbf8f3' };

// Geometry in a 512×512 design space.
const BOOK = { x0: 148, y0: 108, x1: 364, y1: 404, r: 30, stroke: 26 };
const SPINE_X = 192;
const HEART = { cx: 272, bottomY: 312, scale: 100 };
const TILE_RADIUS = 112;

// ---- signed distance functions (negative = inside) ----

function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.min(Math.max((pax * bax + pay * bay) / (bax * bax + bay * bay), 0), 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Inigo Quilez's heart: tip at (0,0), lobes up to y ≈ 1.1, in unit space. */
function sdHeart(x, y) {
  x = Math.abs(x);
  if (y + x > 1) return Math.hypot(x - 0.25, y - 0.75) - Math.SQRT2 / 4;
  const a = Math.hypot(x, y - 1);
  const m = 0.5 * Math.max(x + y, 0);
  const b = Math.hypot(x - m, y - m);
  return Math.min(a, b) * Math.sign(x - y);
}

/** Coverage 0..1 of the white mark at a design-space point. */
function markAt(px, py) {
  const cx = (BOOK.x0 + BOOK.x1) / 2;
  const cy = (BOOK.y0 + BOOK.y1) / 2;
  const hx = (BOOK.x1 - BOOK.x0) / 2;
  const hy = (BOOK.y1 - BOOK.y0) / 2;
  const half = BOOK.stroke / 2;
  if (Math.abs(sdRoundBox(px, py, cx, cy, hx, hy, BOOK.r)) <= half) return true;
  if (sdSegment(px, py, SPINE_X, BOOK.y0 + half, SPINE_X, BOOK.y1 - half) <= half) return true;
  const hxu = (px - HEART.cx) / HEART.scale;
  const hyu = (HEART.bottomY - py) / HEART.scale;
  return sdHeart(hxu, hyu) <= 0;
}

/**
 * RGBA pixels for an icon of `size` px.
 * @param {{ rounded: boolean, inset: number }} opts  inset = fraction of the
 *   tile the mark is scaled into (1 = design size; maskable uses 0.8).
 */
export function renderIcon(size, { rounded, inset }) {
  const SS = 4; // 4×4 supersampling
  const px = new Uint8Array(size * size * 4);
  const k = 512 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS) * k;
          const dy = (y + (sy + 0.5) / SS) * k;
          const inTile = !rounded || sdRoundBox(dx, dy, 256, 256, 256, 256, TILE_RADIUS) <= 0;
          if (!inTile) continue;
          tile++;
          // Scale the mark around the centre into the inset area.
          const mx = 256 + (dx - 256) / inset;
          const my = 256 + (dy - 256) / inset;
          if (markAt(mx, my)) mark++;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const a = tile / n;
      const m = tile ? mark / tile : 0;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BRAND.tile[c] * (1 - m) + BRAND.ink[c] * m);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA8 PNG encoder. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The same mark as an SVG (heart = diamond + two half circles). */
export function renderSvg() {
  const s = HEART.scale;
  const hx = (u) => +(HEART.cx + u * s).toFixed(2);
  const hy = (v) => +(HEART.bottomY - v * s).toFixed(2);
  const r = +((Math.SQRT2 / 4) * s).toFixed(2);
  const w = BOOK.x1 - BOOK.x0 - BOOK.stroke;
  const h = BOOK.y1 - BOOK.y0 - BOOK.stroke;
  const half = BOOK.stroke / 2;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    `  <rect width="512" height="512" rx="${TILE_RADIUS}" fill="${BRAND_HEX.tile}"/>`,
    `  <g fill="none" stroke="${BRAND_HEX.ink}" stroke-width="${BOOK.stroke}" stroke-linecap="round">`,
    `    <rect x="${BOOK.x0 + half}" y="${BOOK.y0 + half}" width="${w}" height="${h}" rx="${BOOK.r - half}"/>`,
    `    <path d="M${SPINE_X} ${BOOK.y0 + half}V${BOOK.y1 - half}"/>`,
    '  </g>',
    `  <path fill="${BRAND_HEX.ink}" d="M${hx(0)} ${hy(0)}L${hx(-0.5)} ${hy(0.5)}A${r} ${r} 0 0 1 ${hx(0)} ${hy(1)}A${r} ${r} 0 0 1 ${hx(0.5)} ${hy(0.5)}Z"/>`,
    '</svg>',
    '',
  ].join('\n');
}

export const OUTPUTS = [
  { file: 'app/apple-icon.png', size: 180, rounded: false, inset: 0.9 },
  { file: 'public/icons/icon-192.png', size: 192, rounded: true, inset: 1 },
  { file: 'public/icons/icon-512.png', size: 512, rounded: true, inset: 1 },
  { file: 'public/icons/icon-maskable-512.png', size: 512, rounded: false, inset: 0.8 },
];

/** `{ path: Buffer|string }` for every generated file. */
export function generateAll() {
  const files = { 'app/icon.svg': renderSvg() };
  for (const o of OUTPUTS) files[o.file] = encodePng(o.size, renderIcon(o.size, o));
  return files;
}

function main() {
  const root = process.cwd();
  for (const [rel, data] of Object.entries(generateAll())) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    console.log(`[icons] wrote ${rel}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
