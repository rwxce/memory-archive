// Synthetic pictures for the loose-files and Google Photos download importers. Invented dates,
// invented places, fake pixels: a "JPEG" is the right header bytes plus filler, never decodable.
// Nothing here comes from a real photo. Deterministic: no clock, no randomness.
//
// `jpeg()` / `heic()` build files with EXIF; `hostileExif()` builds broken and malicious EXIF;
// `googlePhotosDownloadFiles()` is the entries of a photos.google.com download ZIP.
// `writePhotoFixtures(dir)` writes the ZIP to fixtures/google-photos-download.zip (smoke).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const ascii = (text) => strToU8(text);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u16 = (n, le) => (le ? Uint8Array.of(n & 255, n >> 8) : Uint8Array.of(n >> 8, n & 255));
const u32 = (n, le) => (le ? Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255) : Uint8Array.of((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255));
const filler = (seed, kind) => ascii(`FAKE-${kind}-${seed}-`.repeat(8));

// ---- TIFF / EXIF -----------------------------------------------------------------------------

/**
 * A TIFF block with an Exif IFD (date, offset) and a GPS IFD. All fields optional.
 * @param {{ dateTimeOriginal?: string, offsetTime?: string, gps?: { lat: number[], lon: number[], latRef?: string, lonRef?: string }, bigEndian?: boolean }} [options]
 */
export function exifTiff({ dateTimeOriginal, offsetTime, gps, bigEndian = false } = {}) {
  const le = !bigEndian;
  const entry = (tag, type, count, valueOrOffset) => cat(u16(tag, le), u16(type, le), u32(count, le), valueOrOffset);
  const pad4 = (b) => (b.length >= 4 ? b : cat(b, new Uint8Array(4 - b.length)));
  const rational = (n, d) => cat(u32(n, le), u32(d, le));
  const header = cat(ascii(le ? 'II' : 'MM'), u16(42, le), u32(8, le));

  // Layout: IFD0 at 8 (up to 2 entries), then the Exif IFD, then the GPS IFD, then value data.
  const hasExif = dateTimeOriginal !== undefined;
  const ifd0Count = (hasExif ? 1 : 0) + (gps ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifEntries = (dateTimeOriginal !== undefined ? 1 : 0) + (offsetTime !== undefined ? 1 : 0);
  const exifSize = hasExif ? 2 + exifEntries * 12 + 4 : 0;
  const gpsSize = gps ? 2 + 4 * 12 + 4 : 0;
  const exifAt = 8 + ifd0Size;
  const gpsAt = exifAt + exifSize;
  let dataAt = gpsAt + gpsSize;
  const data = [];
  const place = (bytes) => {
    const at = dataAt;
    data.push(bytes);
    dataAt += bytes.length;
    return at;
  };

  const ifd0 = [];
  if (hasExif) ifd0.push(entry(0x8769, 4, 1, u32(exifAt, le)));
  if (gps) ifd0.push(entry(0x8825, 4, 1, u32(gpsAt, le)));
  const parts = [header, u16(ifd0Count, le), ...ifd0, u32(0, le)];

  if (hasExif) {
    const exif = [];
    const dateBytes = cat(ascii(dateTimeOriginal), Uint8Array.of(0));
    exif.push(entry(0x9003, 2, dateBytes.length, u32(place(dateBytes), le)));
    if (offsetTime !== undefined) {
      const o = cat(ascii(offsetTime), Uint8Array.of(0));
      exif.push(entry(0x9011, 2, o.length, o.length <= 4 ? pad4(o) : u32(place(o), le)));
    }
    parts.push(u16(exif.length, le), ...exif, u32(0, le));
  }
  if (gps) {
    const dms = ([d, m, s]) => cat(rational(d, 1), rational(m, 1), rational(s, 100));
    const gpsEntries = [
      entry(1, 2, 2, pad4(cat(ascii(gps.latRef ?? 'N'), Uint8Array.of(0)))),
      entry(2, 5, 3, u32(place(dms(gps.lat)), le)),
      entry(3, 2, 2, pad4(cat(ascii(gps.lonRef ?? 'E'), Uint8Array.of(0)))),
      entry(4, 5, 3, u32(place(dms(gps.lon)), le)),
    ];
    parts.push(u16(gpsEntries.length, le), ...gpsEntries, u32(0, le));
  }
  return cat(...parts, ...data);
}

/** A JPEG: SOI, JFIF, optional Exif APP1, a comment carrying the seed, EOI. */
export function jpeg(seed, tiff) {
  const segment = (marker, body) => cat(Uint8Array.of(0xff, marker), u16(body.length + 2, false), body);
  const jfif = segment(0xe0, cat(ascii('JFIF\0'), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0)));
  const exif = tiff ? segment(0xe1, cat(ascii('Exif\0\0'), tiff)) : new Uint8Array(0);
  return cat(Uint8Array.of(0xff, 0xd8), jfif, exif, segment(0xfe, filler(seed, 'JPG')), Uint8Array.of(0xff, 0xd9));
}

const box = (type, ...body) => {
  const content = cat(...body);
  return cat(u32(content.length + 8, false), ascii(type), content);
};

/** A HEIC: ftyp, meta (iinf with an Exif item, iloc pointing at it), mdat holding the Exif item. */
export function heic(seed, tiff) {
  const ftyp = box('ftyp', ascii('heic'), u32(0, false), ascii('mif1heic'));
  const infe = box('infe', Uint8Array.of(2, 0, 0, 0), u16(1, false), u16(0, false), ascii('Exif'), ascii('Exif\0'));
  const iinf = box('iinf', Uint8Array.of(0, 0, 0, 0), u16(1, false), infe);
  const exifItem = tiff ? cat(u32(6, false), ascii('Exif\0\0'), tiff) : new Uint8Array(0);
  // iloc v0: offset and length 4 bytes each, no base offset, one item (id 1) with one extent.
  const iloc = (dataAt) =>
    box('iloc', Uint8Array.of(0, 0, 0, 0), Uint8Array.of(0x44, 0x00), u16(1, false), u16(1, false), u16(0, false), u16(1, false), u32(dataAt, false), u32(exifItem.length, false));
  const metaOf = (dataAt) => box('meta', Uint8Array.of(0, 0, 0, 0), iinf, iloc(dataAt));
  const meta = metaOf(ftyp.length + metaOf(0).length + 8); // + the mdat header
  const mdat = box('mdat', exifItem, filler(seed, 'HEIC'));
  return cat(ftyp, meta, mdat);
}

// ---- other formats: just enough header for the sniffer -----------------------------------------

export const png = (seed) => cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), filler(seed, 'PNG'));
export const mp4 = (seed) => cat(u32(24, false), ascii('ftypisom'), u32(0, false), ascii('isomiso2'), filler(seed, 'MP4'));
export const mov = (seed) => cat(u32(20, false), ascii('ftypqt  '), u32(0, false), ascii('qt  '), filler(seed, 'MOV'));
export const gif = (seed) => cat(ascii('GIF89a'), Uint8Array.of(1, 0, 1, 0, 0, 0, 0), filler(seed, 'GIF'));
export const webp = (seed) => cat(ascii('RIFF'), u32(16, true), ascii('WEBPVP8 '), filler(seed, 'WEBP'));
/** Looks like a picture by name, is a web page by content. */
export const htmlDisguisedAsJpeg = () => ascii('<html><script>alert(1)</script></html>');

// ---- hostile EXIF ------------------------------------------------------------------------------

/** JPEGs whose Exif segment is damaged or malicious. Every one must read as "no metadata". */
export function hostileExif() {
  const wrap = (tiff) => jpeg(0, tiff);
  const header = (ifd0At) => cat(ascii('II'), u16(42, true), u32(ifd0At, true));
  const entry = (tag, type, count, value) => cat(u16(tag, true), u16(type, true), u32(count, true), value);
  const out = {};
  // IFD0 points at itself as its Exif IFD: must not loop.
  out.selfPointer = wrap(cat(header(8), u16(1, true), entry(0x8769, 4, 1, u32(8, true)), u32(0, true)));
  // 65535 entries declared in a few bytes.
  out.hugeEntryCount = wrap(cat(header(8), u16(65535, true), new Uint8Array(24)));
  // The IFD itself lies outside the block.
  out.ifdOutside = wrap(header(0x7fffffff));
  // A date whose value offset is far outside the block.
  out.valueOutside = wrap(cat(header(8), u16(1, true), entry(0x8769, 4, 1, u32(26, true)), u32(0, true), u16(1, true), entry(0x9003, 2, 20, u32(0xfffffff0, true)), u32(0, true)));
  // A count that overflows 32-bit arithmetic.
  out.hugeCount = wrap(cat(header(8), u16(1, true), entry(0x8769, 4, 1, u32(26, true)), u32(0, true), u16(1, true), entry(0x9003, 2, 0xffffffff, u32(40, true)), u32(0, true)));
  // Segment length lies: longer than the file.
  out.lyingSegment = cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff), ascii('Exif\0\0'), header(8));
  // Not a TIFF at all.
  out.badByteOrder = wrap(cat(ascii('XX'), u16(42, true), u32(8, true)));
  out.badMagic = wrap(cat(ascii('II'), u16(43, true), u32(8, true)));
  // A chain of 200 empty segments before the Exif one (a scan-time bomb).
  out.manySegments = cat(Uint8Array.of(0xff, 0xd8), ...Array.from({ length: 200 }, () => Uint8Array.of(0xff, 0xe2, 0, 4, 0, 0)), jpeg(0, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00' })).subarray(2));
  // Truncated in the middle of the Exif block.
  out.truncated = jpeg(0, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00' })).subarray(0, 40);
  return out;
}

/** Dates and places that parse but are garbage. Each is a JPEG that must carry no date / no place. */
export function garbageValues() {
  const date = (d) => jpeg(0, exifTiff({ dateTimeOriginal: d }));
  return {
    zeroDate: date('0000:00:00 00:00:00'),
    month13: date('2019:13:01 10:00:00'),
    feb31: date('2019:02:31 10:00:00'),
    hour25: date('2019:07:01 25:00:00'),
    notADate: date('yesterday afternoon'),
    farFuture: date('9999:07:01 10:00:00'),
    badLatitude: jpeg(0, exifTiff({ gps: { lat: [999, 0, 0], lon: [2, 0, 0] } })),
    nullIsland: jpeg(0, exifTiff({ gps: { lat: [0, 0, 0], lon: [0, 0, 0] } })),
  };
}

// ---- a photos.google.com download ZIP ----------------------------------------------------------

/**
 * Entries of a "Download" ZIP from Google Photos: flat, no sidecars. A mix of pictures with and
 * without EXIF, a video, and things that must not be imported.
 */
/** @returns {Record<string, Uint8Array>} */
export function googlePhotosDownloadFiles() {
  /** @type {Record<string, Uint8Array>} */
  const f = {};
  // Camera date with a UTC offset (+02:00 summer time): a real instant, 08:00:00Z.
  f['IMG_20190701_100000.jpg'] = jpeg(1, exifTiff({ dateTimeOriginal: '2019:07:01 10:00:00', offsetTime: '+02:00', gps: { lat: [38, 42, 5000], lon: [9, 8, 1000], latRef: 'N', lonRef: 'W' } }));
  // Camera date without an offset: wall-clock digits.
  f['IMG_20190702_110000.jpg'] = jpeg(2, exifTiff({ dateTimeOriginal: '2019:07:02 11:00:00', bigEndian: true }));
  // No EXIF at all (a screenshot, a download).
  f['Screenshot_1.png'] = png(3);
  f['IMG_noexif.jpg'] = jpeg(4);
  f['VID_20190703.mp4'] = mp4(5);
  f['IMG_heic.heic'] = heic(6, exifTiff({ dateTimeOriginal: '2019:07:04 12:30:00', offsetTime: '-03:00' }));
  // Not pictures.
  f['notes.txt'] = ascii('not a picture');
  f['fake.jpg'] = htmlDisguisedAsJpeg();
  f['photo.mp4'] = jpeg(7); // a picture named like a video
  f['__MACOSX/._IMG_20190701_100000.jpg'] = ascii('resource fork');
  return f;
}

export const googlePhotosDownloadZip = (files = googlePhotosDownloadFiles()) => zipSync(files, { level: 0 });

export function writePhotoFixtures(fixturesDir) {
  fs.writeFileSync(path.join(fixturesDir, 'google-photos-download.zip'), googlePhotosDownloadZip());
}
