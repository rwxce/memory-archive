import * as fs from 'node:fs';
import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import type { Message } from './parse/types';

/**
 * Maximum byte size for a media file to be eligible for `--inline` base64
 * embedding (D-M6). Files larger than this, or any video, are skipped by
 * default and fall back to a relative link / placeholder.
 */
export const INLINE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Canonicalize a media filename for tolerant matching (D-M2 / MEDIA-01):
 * lower-case, drop a trailing parenthesized duplicate marker (`(1)`), and
 * collapse runs of whitespace / `-` / `_` to nothing. Digits are preserved so
 * real date-stamped names stay distinct.
 *
 *   normalizeMediaName('Photo (1).JPG') === normalizeMediaName('photo.jpg')
 *   normalizeMediaName('IMG 20190424 WA0003.jpg') === normalizeMediaName('IMG-20190424-WA0003.jpg')
 */
export function normalizeMediaName(s: string): string {
  return s.toLowerCase().replace(/\(\d+\)/g, '').replace(/[\s_-]+/g, '');
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

/** Resolve a file extension to a MIME type (no dependency). D-M4. */
export function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[e] ?? 'application/octet-stream';
}

/** True when a file may be inlined as a `data:` URI (D-M6 / MEDIA-03). */
export function isInlineable(mime: string, size: number): boolean {
  return size <= INLINE_MAX_BYTES && !mime.startsWith('video/');
}

function isAppleDouble(name: string): boolean {
  const base = name.split('/').pop() ?? '';
  return name.includes('__MACOSX') || base.startsWith('._');
}

interface ZipEntryMeta {
  name: string;
  localOffset: number;
  compressedSize: number;
  compression: number;
}

/**
 * Read only the ZIP central directory (EOCD + central records) to recover each
 * entry's exact name, local-header offset and **authoritative** compressed
 * size. The central directory always carries correct sizes even for members
 * stored with a data descriptor (local-header `csize = 0`, flag bit 3) — a
 * layout fflate's streaming inflate mis-handles on real WhatsApp exports
 * (e.g. an attached inner `.zip`). This pass reads metadata only; no entry
 * bytes are buffered (PARSE-02).
 */
function readCentralDirectory(zipPath: string): ZipEntryMeta[] {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const maxBack = Math.min(stat.size, 22 + 0xffff);
    const tail = Buffer.alloc(maxBack);
    fs.readSync(fd, tail, 0, maxBack, stat.size - maxBack);
    let eocd = -1;
    for (let i = maxBack - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
    const entries: ZipEntryMeta[] = [];
    let p = 0;
    for (let n = 0; n < cdCount; n++) {
      if (cdBuf.readUInt32LE(p) !== 0x02014b50) break; // central-file signature
      const compression = cdBuf.readUInt16LE(p + 10);
      const compressedSize = cdBuf.readUInt32LE(p + 20);
      const nlen = cdBuf.readUInt16LE(p + 28);
      const elen = cdBuf.readUInt16LE(p + 30);
      const clen = cdBuf.readUInt16LE(p + 32);
      const localOffset = cdBuf.readUInt32LE(p + 42);
      const name = cdBuf.toString('utf8', p + 46, p + 46 + nlen);
      entries.push({ name, localOffset, compressedSize, compression });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream a single zip member's bytes from disk into `outPath`, inflating raw
 * DEFLATE (method 8) on the fly, or copying stored bytes (method 0). The input
 * `ReadStream` is bounded to exactly one entry via `start`/`end`, so a large
 * video/inner-zip is streamed entry-by-entry — the whole archive is never
 * buffered (PARSE-02).
 */
async function extractEntry(
  zipPath: string,
  entry: ZipEntryMeta,
  outPath: string,
): Promise<void> {
  const fh = await open(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, entry.localOffset);
    const nlen = lh.readUInt16LE(26);
    const elen = lh.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nlen + elen;
    const rs = createReadStream(zipPath, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
    });
    const ws = createWriteStream(outPath);
    const source =
      entry.compression === 0 ? rs : rs.pipe(zlib.createInflateRaw());
    await new Promise<void>((res, rej) => {
      source.on('error', rej);
      ws.on('error', rej);
      ws.on('close', res);
      source.pipe(ws);
    });
  } finally {
    await fh.close();
  }
}

export interface ReconcileResult {
  /** Distinct refs that matched an actual zip entry. */
  resolved: string[];
  /** Distinct refs with no matching entry. */
  unresolved: string[];
}

/**
 * Locate media referenced by `_chat.txt` and copy the matched zip entries into
 * `<dir>/media/`, streaming each per-entry from the central-directory index
 * (PARSE-02 / D-M3 — the whole archive is never buffered). Returns the resolved
 * and unresolved refs.
 *
 * @param zipPath  Path to the WhatsApp export ZIP.
 * @param dir      Output directory (the `<slug>` folder). `media/` is created
 *                underneath it.
 * @param refs     Distinct media filenames referenced by messages.
 */
export async function reconcileMedia(
  zipPath: string,
  dir: string,
  refs: string[],
): Promise<ReconcileResult> {
  const refsNormalized = new Map<string, string>(); // normalized -> original ref
  for (const r of refs) {
    const n = normalizeMediaName(r);
    if (n) refsNormalized.set(n, r);
  }

  const mediaDir = path.join(dir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });

  const entries = readCentralDirectory(zipPath);
  const index = new Map<string, ZipEntryMeta>(); // normalized base -> meta
  for (const e of entries) {
    const base = e.name.split('/').pop()!;
    if (isAppleDouble(e.name) || base.endsWith('_chat.txt')) {
      continue;
    }
    index.set(normalizeMediaName(base), e);
  }

  const resolvedSet = new Set<string>();
  const resolved: string[] = [];
  const writes: Promise<void>[] = [];
  for (const [norm, ref] of refsNormalized) {
    const meta = index.get(norm);
    if (!meta) continue; // unreferenced / missing -> unresolved
    const base = meta.name.split('/').pop()!;
    writes.push(
      extractEntry(zipPath, meta, path.join(mediaDir, base)).then(() => {
        if (!resolvedSet.has(ref)) {
          resolvedSet.add(ref);
          resolved.push(ref);
        }
      }),
    );
  }
  await Promise.all(writes);

  const unresolved = [...refsNormalized.values()].filter(
    (r) => !resolvedSet.has(r),
  );
  return { resolved, unresolved };
}

export interface MediaEntry {
  /** Relative path as referenced by renderers: `media/<file>`. */
  relPath: string;
  mime: string;
  /** Whether this file may be inlined as a `data:` URI (D-M6). */
  inlineable: boolean;
  size: number;
}

/**
 * Build a disk-resident media map (D-M5): scan `<dir>/media/*` once and resolve
 * each message's `media` ref to its on-disk file. Refs with no file on disk are
 * **absent** from the map (renderers treat them as missing-but-expected).
 *
 * @param dir      Output directory containing `media/`.
 * @param messages The parsed/merged messages (CSV source-of-truth).
 */
export function buildMediaMap(
  dir: string,
  messages: Message[],
): Map<string, MediaEntry> {
  const mediaDir = path.join(dir, 'media');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const index = new Map<string, string>(); // normalized -> actual filename
  for (const e of entries) {
    if (e.isDirectory()) continue;
    if (e.name.startsWith('._')) continue;
    index.set(normalizeMediaName(e.name), e.name);
  }

  const map = new Map<string, MediaEntry>();
  for (const m of messages) {
    if (!m.media) continue;
    const hit = index.get(normalizeMediaName(m.media));
    if (!hit) continue; // missing-but-expected: not in map
    const full = path.join(mediaDir, hit);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    const mime = mimeFromExt(path.extname(hit));
    map.set(m.media, {
      relPath: `media/${hit}`,
      mime,
      size,
      inlineable: isInlineable(mime, size),
    });
  }
  return map;
}
