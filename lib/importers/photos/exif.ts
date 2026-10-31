import { isTakenAt } from '../../domain/photo';
import type { SniffedMedia } from './sniff';

/**
 * A small, hardened EXIF reader: the date a picture was taken (DateTimeOriginal with
 * OffsetTimeOriginal when present) and, when well formed, where (GPS). Nothing is decoded.
 *
 * Input is the first `EXIF_PREFIX_BYTES` of an untrusted file; nothing outside it is ever read.
 * Every offset and length is checked against that buffer before use, every loop has a fixed cap,
 * IFDs are visited once each (IFD0, then the Exif and GPS IFDs it points to; a pointer back to an
 * IFD already visited is ignored, so there is no recursion), and a failure of any kind means "no
 * metadata" (null), never an exception. JPEG (APP1 `Exif` segment) and HEIC/HEIF (the `Exif` item
 * found through `iinf` / `iloc`) are read; a HEIF whose Exif item lies beyond the prefix is not.
 * Format: `docs/formats/photo-library.md`.
 */

export const EXIF_PREFIX_BYTES = 256 * 1024;

export interface ExifInfo {
  /** `YYYY-MM-DDTHH:MM:SSZ`; null when the picture has no usable DateTimeOriginal. */
  takenAt: string | null;
  /** `offset`: a real instant (OffsetTimeOriginal known). `local`: the camera's wall-clock digits, stored as if UTC. */
  zone: 'offset' | 'local' | null;
  /** The camera's UTC offset in minutes when `zone` is `offset`, else null. */
  offsetMinutes: number | null;
  latitude: number | null;
  longitude: number | null;
}

class Bad extends Error {}

const MAX_JPEG_SEGMENTS = 128;
const MAX_IFD_ENTRIES = 512;
const MAX_TOP_BOXES = 256;
const MAX_ITEMS = 4096;
const MAX_EXIF_BYTES = 1024 * 1024;

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_OFFSET_ORIGINAL = 0x9011;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset (in the TIFF block) of the value bytes. */
  at: number;
}

class Tiff {
  constructor(
    private readonly view: DataView,
    private readonly le: boolean,
  ) {}
  get length(): number {
    return this.view.byteLength;
  }
  need(at: number, n: number): void {
    if (!Number.isSafeInteger(at) || at < 0 || at + n > this.view.byteLength) throw new Bad();
  }
  u8(at: number): number {
    this.need(at, 1);
    return this.view.getUint8(at);
  }
  u16(at: number): number {
    this.need(at, 2);
    return this.view.getUint16(at, this.le);
  }
  u32(at: number): number {
    this.need(at, 4);
    return this.view.getUint32(at, this.le);
  }
  ascii(at: number, n: number): string {
    this.need(at, n);
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.view.getUint8(at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  /** The entries of the IFD at `offset` (at most `MAX_IFD_ENTRIES`); an IFD that does not fit is bad. */
  ifd(offset: number): Map<number, Entry> {
    const n = this.u16(offset);
    if (n > MAX_IFD_ENTRIES) throw new Bad();
    this.need(offset + 2, n * 12);
    const entries = new Map<number, Entry>();
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const unit = TYPE_SIZE[type];
      if (unit === undefined) continue;
      const size = unit * count;
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      if (at + size > this.view.byteLength) continue; // value outside the block: this entry only is ignored
      if (!entries.has(tag)) entries.set(tag, { tag, type, count, at });
    }
    return entries;
  }
}

function parseDate(text: string, offsetText: string | null): { takenAt: string; zone: 'offset' | 'local'; offsetMinutes: number | null } | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1900 || year > 2100) return null;
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  if (!isTakenAt(wall)) return null; // 0000:00:00, month 13, 31 February, 25 o'clock...
  if (wall === '1970-01-01T00:00:00Z') return null; // a camera with an unset clock; other "default" dates are indistinguishable from real ones
  const zone = offsetText === null ? null : /^([+-])(\d{2}):(\d{2})$/.exec(offsetText.trim());
  if (!zone) return { takenAt: wall, zone: 'local', offsetMinutes: null };
  const hours = Number(zone[2]);
  const minutes = Number(zone[3]);
  const total = hours * 60 + minutes;
  // Real zones: minutes 00 / 30 / 45, at most +14:00. Anything else is a damaged tag: keep the digits.
  if (![0, 30, 45].includes(minutes) || total > 14 * 60) return { takenAt: wall, zone: 'local', offsetMinutes: null };
  const offsetMinutes = zone[1] === '-' ? -total : total;
  const shift = offsetMinutes * 60_000;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - shift).toISOString();
  const takenAt = `${utc.slice(0, 19)}Z`;
  return isTakenAt(takenAt) ? { takenAt, zone: 'offset', offsetMinutes } : null;
}

function readCoordinate(t: Tiff, ref: Entry | undefined, value: Entry | undefined, positive: string, negative: string, limit: number): number | null {
  if (!ref || !value || ref.type !== 2 || value.type !== 5 || value.count !== 3 || ref.count < 1) return null;
  const letter = t.ascii(ref.at, 1);
  if (letter !== positive && letter !== negative) return null;
  const parts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const den = t.u32(value.at + i * 8 + 4);
    if (den === 0) return null;
    parts.push(t.u32(value.at + i * 8) / den);
  }
  const degrees = parts[0] + parts[1] / 60 + parts[2] / 3600;
  if (!Number.isFinite(degrees) || parts[1] >= 60 || parts[2] >= 60 || degrees > limit) return null;
  return letter === negative ? -degrees : degrees;
}

function parseTiff(block: Uint8Array): ExifInfo | null {
  if (block.length < 8) return null;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const order = String.fromCharCode(block[0], block[1]);
  if (order !== 'II' && order !== 'MM') return null;
  const t = new Tiff(view, order === 'II');
  if (t.u16(2) !== 42) return null;

  const info: ExifInfo = { takenAt: null, zone: null, offsetMinutes: null, latitude: null, longitude: null };
  const ifd0Offset = t.u32(4);
  const visited = new Set<number>([ifd0Offset]);
  const ifd0 = t.ifd(ifd0Offset);
  const pointer = (entry: Entry | undefined): number | null => {
    if (!entry || entry.type !== 4 || entry.count !== 1) return null;
    const offset = t.u32(entry.at);
    if (visited.has(offset)) return null;
    visited.add(offset);
    return offset;
  };

  try {
    const exifOffset = pointer(ifd0.get(TAG_EXIF_IFD));
    if (exifOffset !== null) {
      const exif = t.ifd(exifOffset);
      const date = exif.get(TAG_DATE_ORIGINAL);
      if (date && date.type === 2 && date.count >= 19 && date.count <= 64) {
        const offsetEntry = exif.get(TAG_OFFSET_ORIGINAL);
        const offsetText = offsetEntry && offsetEntry.type === 2 && offsetEntry.count >= 6 && offsetEntry.count <= 16 ? t.ascii(offsetEntry.at, offsetEntry.count) : null;
        const parsed = parseDate(t.ascii(date.at, date.count), offsetText);
        if (parsed) {
          info.takenAt = parsed.takenAt;
          info.zone = parsed.zone;
          info.offsetMinutes = parsed.offsetMinutes;
        }
      }
    }
  } catch {
    // A damaged Exif IFD costs the date, not the place.
  }
  try {
    const gpsOffset = pointer(ifd0.get(TAG_GPS_IFD));
    if (gpsOffset !== null) {
      const gps = t.ifd(gpsOffset);
      const latitude = readCoordinate(t, gps.get(1), gps.get(2), 'N', 'S', 90);
      const longitude = readCoordinate(t, gps.get(3), gps.get(4), 'E', 'W', 180);
      // (0, 0) is "no fix" for most cameras, as in Takeout.
      if (latitude !== null && longitude !== null && !(latitude === 0 && longitude === 0)) {
        info.latitude = latitude;
        info.longitude = longitude;
      }
    }
  } catch {
    // Same: the place is dropped, the date stays.
  }
  return info.takenAt === null && info.latitude === null ? null : info;
}

/** The TIFF block of a JPEG's Exif APP1 segment. */
function jpegExifBlock(b: Uint8Array): Uint8Array | null {
  let pos = 2; // after SOI
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    while (pos < b.length && b[pos] === 0xff && b[pos + 1] === 0xff) pos++; // fill bytes
    if (pos + 4 > b.length || b[pos] !== 0xff) return null;
    const marker = b[pos + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end: no Exif before the pixels
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = (b[pos + 2] << 8) | b[pos + 3];
    if (length < 2) return null;
    if (marker === 0xe1 && length >= 8 && b[pos + 4] === 0x45 && b[pos + 5] === 0x78 && b[pos + 6] === 0x69 && b[pos + 7] === 0x66 && b[pos + 8] === 0 && b[pos + 9] === 0) {
      return b.subarray(pos + 10, Math.min(pos + 2 + length, b.length));
    }
    pos += 2 + length;
  }
  return null;
}

/** Minimal bounds-checked reads over the ISO base media boxes of a HEIC/HEIF file. */
class Boxes {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(at: number): number {
    if (at < 0 || at + 1 > this.bytes.length) throw new Bad();
    return this.bytes[at];
  }
  u16(at: number): number {
    if (at < 0 || at + 2 > this.bytes.length) throw new Bad();
    return this.view.getUint16(at);
  }
  u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.length) throw new Bad();
    return this.view.getUint32(at);
  }
  /** An unsigned integer of 0, 4 or 8 bytes (the widths ISO 14496-12 allows here). */
  uint(at: number, width: number): number {
    if (width === 0) return 0;
    if (width === 4) return this.u32(at);
    if (width !== 8) throw new Bad();
    const hi = this.u32(at);
    if (hi >= 0x200000) throw new Bad(); // above 2^53
    return hi * 2 ** 32 + this.u32(at + 4);
  }
  type(at: number): string {
    return String.fromCharCode(this.u8(at), this.u8(at + 1), this.u8(at + 2), this.u8(at + 3));
  }
  /** `[start of content, end]` of the box at `at` inside `end`, and its type. */
  box(at: number, end: number): { type: string; start: number; end: number } {
    if (at + 8 > end) throw new Bad();
    let size = this.u32(at);
    let header = 8;
    if (size === 1) {
      size = this.uint(at + 8, 8);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Bad();
    return { type: this.type(at + 4), start: at + header, end: at + size };
  }
}

function heifExifBlock(b: Uint8Array): Uint8Array | null {
  const r = new Boxes(b);
  let meta: { start: number; end: number } | null = null;
  for (let at = 0, n = 0; at < b.length && n < MAX_TOP_BOXES; n++) {
    const box = r.box(at, b.length);
    if (box.type === 'meta') {
      meta = box;
      break;
    }
    at = box.end;
  }
  if (!meta) return null;

  let exifId: number | null = null;
  let iloc: { start: number; end: number } | null = null;
  for (let at = meta.start + 4, n = 0; at < meta.end && n < MAX_TOP_BOXES; n++) {
    const box = r.box(at, meta.end);
    if (box.type === 'iinf') {
      const version = r.u8(box.start);
      let p = box.start + 4;
      const count = version === 0 ? r.u16(p) : r.u32(p);
      p += version === 0 ? 2 : 4;
      for (let i = 0; i < Math.min(count, MAX_ITEMS) && p < box.end; i++) {
        const infe = r.box(p, box.end);
        p = infe.end;
        if (infe.type !== 'infe') continue;
        const v = r.u8(infe.start);
        if (v < 2) continue;
        const id = v === 2 ? r.u16(infe.start + 4) : r.u32(infe.start + 4);
        const typeAt = infe.start + 4 + (v === 2 ? 2 : 4) + 2;
        if (r.type(typeAt) === 'Exif') exifId = id;
      }
    } else if (box.type === 'iloc') iloc = box;
    at = box.end;
  }
  if (exifId === null || !iloc) return null;

  const version = r.u8(iloc.start);
  if (version > 2) return null;
  let p = iloc.start + 4;
  const sizes = r.u8(p);
  const bases = r.u8(p + 1);
  p += 2;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 15;
  const baseSize = bases >> 4;
  const indexSize = version === 0 ? 0 : bases & 15;
  const count = version < 2 ? r.u16(p) : r.u32(p);
  p += version < 2 ? 2 : 4;
  for (let i = 0; i < Math.min(count, MAX_ITEMS); i++) {
    const id = version < 2 ? r.u16(p) : r.u32(p);
    p += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) {
      method = r.u16(p) & 15;
      p += 2;
    }
    p += 2; // data reference index
    const base = r.uint(p, baseSize);
    p += baseSize;
    const extents = r.u16(p);
    p += 2;
    const stride = indexSize + offsetSize + lengthSize;
    if (id === exifId) {
      if (method !== 0 || extents !== 1) return null;
      const offset = base + r.uint(p + indexSize, offsetSize);
      const length = r.uint(p + indexSize + offsetSize, lengthSize);
      if (length < 12 || length > MAX_EXIF_BYTES || offset + length > b.length) return null;
      const data = b.subarray(offset, offset + length);
      const headerSkip = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      if (4 + headerSkip >= data.length) return null;
      return data.subarray(4 + headerSkip);
    }
    if (extents > 16) return null;
    p += extents * stride;
  }
  return null;
}

/**
 * The EXIF date taken and place of a picture, from the first bytes of its file (`head`) and the
 * format `acceptMedia` recognized. Null when there is none, or it is damaged or hostile.
 */
export function readExif(head: Uint8Array, format: SniffedMedia['exif']): ExifInfo | null {
  if (format === null) return null;
  try {
    const block = format === 'jpeg' ? jpegExifBlock(head) : heifExifBlock(head);
    return block ? parseTiff(block) : null;
  } catch {
    return null;
  }
}
