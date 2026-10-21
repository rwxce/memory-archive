import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { isVideoFileName } from '../importers/whatsapp/message';
import { ImportError } from './import';
import { estimateImport, SPACE_MARGIN_FACTOR, SPACE_MARGIN_FIXED_BYTES } from './import-space';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const encoder = new TextEncoder();

interface Declared {
  name: string;
  /** Uncompressed size. */
  size: number;
  /** Compressed size; defaults to 1 (the data is not there anyway). */
  compressed?: number;
  /** Write the sizes in a ZIP64 extra field (classic fields 0xFFFFFFFF), as a >4 GiB entry must. */
  zip64?: boolean;
}

/**
 * A ZIP made only of a central directory that DECLARES the sizes (no entry data follows), so a
 * 5 GiB video costs nothing to build. `estimateImport` must never read past the directory.
 */
function declaredZip(entries: Declared[]): Blob {
  const records: Uint8Array[] = [];
  for (const { name, size, compressed = 1, zip64 } of entries) {
    const nameBytes = encoder.encode(name);
    const extraLen = zip64 ? 4 + 16 : 0;
    const record = new DataView(new ArrayBuffer(46 + nameBytes.length + extraLen));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(10, 8, true);
    record.setUint32(20, zip64 ? 0xffffffff : compressed, true);
    record.setUint32(24, zip64 ? 0xffffffff : size, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint16(30, extraLen, true);
    new Uint8Array(record.buffer).set(nameBytes, 46);
    if (zip64) {
      const at = 46 + nameBytes.length;
      record.setUint16(at, 0x0001, true);
      record.setUint16(at + 2, 16, true);
      record.setBigUint64(at + 4, BigInt(size), true); // uncompressed first, then compressed
      record.setBigUint64(at + 12, BigInt(compressed), true);
    }
    records.push(new Uint8Array(record.buffer));
  }
  const cdSize = records.reduce((n, r) => n + r.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, 0, true);
  return new Blob([...records, new Uint8Array(eocd.buffer)] as BlobPart[]);
}

const needed = (bytes: number, largest: number) => Math.ceil(bytes * SPACE_MARGIN_FACTOR) + SPACE_MARGIN_FIXED_BYTES + largest;

describe('estimateImport', () => {
  const zip = declaredZip([
    { name: '_chat.txt', size: 1 * MiB },
    { name: 'IMG-1.jpg', size: 4 * MiB },
    { name: 'VID-1.MP4', size: 600 * MiB },
    { name: 'clip.mov', size: 100 * MiB },
    { name: 'sub/', size: 0 },
  ]);
  const RAW = 705 * MiB;
  const LARGEST = 600 * MiB;

  test('adds up the declared sizes and the videos, plus a margin and the largest file', async () => {
    const e = await estimateImport(zip, { usage: 0, quota: 10 * GiB });
    expect(e.videoBytes).toBe(700 * MiB);
    expect(e.neededBytes).toBe(needed(RAW, LARGEST));
    expect(e).toMatchObject({ availableBytes: 10 * GiB, fits: true, fitsWithoutVideos: true, suggestSkipVideos: false });
  });

  test('does not fit, but would without videos: suggests skipping them', async () => {
    const e = await estimateImport(zip, { usage: 1 * GiB, quota: 1 * GiB + 200 * MiB });
    expect(e.availableBytes).toBe(200 * MiB);
    expect(e).toMatchObject({ fits: false, fitsWithoutVideos: true, suggestSkipVideos: true });
  });

  test('does not fit even without videos: no suggestion that would not help', async () => {
    const e = await estimateImport(zip, { usage: 0, quota: 10 * MiB });
    expect(e).toMatchObject({ fits: false, fitsWithoutVideos: false, suggestSkipVideos: false });
  });

  test('no videos: nothing to suggest', async () => {
    const e = await estimateImport(declaredZip([{ name: 'IMG-1.jpg', size: 300 * MiB }]), { usage: 0, quota: 100 * MiB });
    expect(e).toMatchObject({ videoBytes: 0, fits: false, suggestSkipVideos: false });
  });

  test('the margin and the largest file count: the exact need fits, one byte less does not', async () => {
    const exact = needed(RAW, LARGEST);
    expect((await estimateImport(zip, { usage: 0, quota: exact })).fits).toBe(true);
    expect((await estimateImport(zip, { usage: 0, quota: exact - 1 })).fits).toBe(false);
    expect((await estimateImport(zip, { usage: 0, quota: RAW + 10 * MiB })).fits).toBe(false);
  });

  test('without videos, the largest file is the largest NON-video one', async () => {
    const e = await estimateImport(zip, { usage: 0, quota: needed(5 * MiB, 4 * MiB) });
    expect(e.fitsWithoutVideos).toBe(true);
    expect((await estimateImport(zip, { usage: 0, quota: needed(5 * MiB, 4 * MiB) - 1 })).fitsWithoutVideos).toBe(false);
  });

  test('unknown quota or usage: nothing is known, nothing blocks', async () => {
    for (const storage of [
      { usage: null, quota: null },
      { usage: 5, quota: null },
      { usage: null, quota: 5 * GiB },
    ]) {
      const e = await estimateImport(zip, storage);
      expect(e).toMatchObject({ availableBytes: null, fits: null, fitsWithoutVideos: null, suggestSkipVideos: false });
      expect(e.neededBytes).toBeGreaterThan(RAW);
    }
  });

  test('usage above quota is zero room, not a negative number', async () => {
    expect((await estimateImport(zip, { usage: 3 * GiB, quota: 2 * GiB })).availableBytes).toBe(0);
  });
});

describe('estimateImport: what counts as a video is the importer\'s rule', () => {
  const videoBytesOf = async (names: string[]) =>
    (await estimateImport(declaredZip(names.map((name) => ({ name, size: MiB }))), { usage: 0, quota: GiB })).videoBytes / MiB;

  test('.m4v and .avi without a VID-/VIDEO name marker are not videos (the importer would not skip them)', async () => {
    expect(isVideoFileName('holiday.m4v')).toBe(false);
    expect(isVideoFileName('holiday.avi')).toBe(false);
    expect(await videoBytesOf(['holiday.m4v', 'holiday.avi', 'a.3g2'])).toBe(0);
  });

  test('.MP4 in capitals, .mov, .webm, .mkv, .3gp are videos; a VID-/VIDEO marker makes any extension one', async () => {
    expect(await videoBytesOf(['a.MP4', 'b.MoV', 'c.webm', 'd.mkv', 'e.3gp'])).toBe(5);
    expect(await videoBytesOf(['VID-20260317-WA0001.avi', '00000003-VIDEO-2026-03-18.m4v', 'IMG-1.jpg'])).toBe(2);
  });

  test('the photo rule wins over the extension, like in the importer (IMG-… .mp4 is a photo)', async () => {
    expect(isVideoFileName('IMG-1.mp4')).toBe(false);
    expect(await videoBytesOf(['IMG-1.mp4', 'PHOTO.mov'])).toBe(0);
  });

  test('names without an extension: judged by the marker only', async () => {
    expect(await videoBytesOf(['VID-0003', 'notes', 'mp4'])).toBe(1);
  });

  test('only the file name counts, never the directory: a dotted directory with a bare file', async () => {
    expect(await videoBytesOf(['trip.mp4/readme', 'media.v2/VID-9', 'media.v2/IMG-9'])).toBe(1);
    // A directory entry is not a file at all.
    const dirOnly = await estimateImport(declaredZip([{ name: 'clips.mp4/', size: 0 }, { name: 'x', size: 10 }]), { usage: 0, quota: GiB });
    expect(dirOnly.videoBytes).toBe(0);
  });
});

describe('estimateImport: sizes from the central directory', () => {
  test('a ZIP64 record (classic fields 0xFFFFFFFF, sizes in the extra field) above 4 GiB', async () => {
    const e = await estimateImport(
      declaredZip([
        { name: '_chat.txt', size: MiB },
        { name: 'VID-big.mp4', size: 5 * GiB, compressed: 5 * GiB, zip64: true },
      ]),
      { usage: 0, quota: 100 * GiB },
    );
    expect(e.videoBytes).toBe(5 * GiB);
    expect(e.neededBytes).toBe(needed(5 * GiB + MiB, 5 * GiB));
    expect(e.fits).toBe(true);
    const tight = await estimateImport(
      declaredZip([{ name: 'VID-big.mp4', size: 5 * GiB, compressed: 5 * GiB, zip64: true }]),
      { usage: 0, quota: 5 * GiB },
    );
    expect(tight).toMatchObject({ fits: false, suggestSkipVideos: true });
  });

  test('deflated entries: the need is the UNCOMPRESSED size, not what the ZIP takes', async () => {
    const e = await estimateImport(
      declaredZip([
        { name: '_chat.txt', size: 2 * MiB, compressed: 200 * 1024 },
        { name: 'IMG-1.jpg', size: 50 * MiB, compressed: 10 * MiB },
      ]),
      { usage: 0, quota: GiB },
    );
    expect(e.neededBytes).toBe(needed(52 * MiB, 50 * MiB));
  });

  test('reads only the directory: no stream(), text() or arrayBuffer() on the file, and a fraction of its bytes', async () => {
    const real = new Blob([zipSync({ '_chat.txt': strToU8('x'.repeat(1000)), 'IMG-1.jpg': [new Uint8Array(300_000), { level: 0 }] }) as BlobPart]);
    const reads: { method: string; bytes: number }[] = [];
    const guarded = (blob: Blob): Blob =>
      ({
        size: blob.size,
        slice: (start?: number, end?: number) => guarded(blob.slice(start, end)),
        arrayBuffer: async () => {
          reads.push({ method: 'arrayBuffer', bytes: blob.size });
          return blob.arrayBuffer();
        },
        stream: () => {
          reads.push({ method: 'stream', bytes: blob.size });
          throw new Error('stream() is not allowed');
        },
        text: () => {
          reads.push({ method: 'text', bytes: blob.size });
          throw new Error('text() is not allowed');
        },
      }) as unknown as Blob;
    const e = await estimateImport(guarded(real), { usage: 0, quota: GiB });
    expect(e.neededBytes).toBe(needed(301_000, 300_000));
    // Only slices were read (never the whole file), and never as a stream or text.
    expect(reads.every((r) => r.method === 'arrayBuffer')).toBe(true);
    expect(reads.reduce((n, r) => n + r.bytes, 0)).toBeLessThan(real.size);
    expect(reads.every((r) => r.bytes < 100_000)).toBe(true);
  });

  test('refuses what the import would refuse: not a ZIP, too many entries', async () => {
    const zip = declaredZip([{ name: 'a', size: 1 }, { name: 'b', size: 1 }, { name: 'c', size: 1 }]);
    await expect(estimateImport(new Blob(['not a zip at all, just text']), { usage: 0, quota: 1 })).rejects.toMatchObject({ code: 'invalid-export' });
    await expect(estimateImport(zip, { usage: 0, quota: 1 }, { maxEntries: 2 })).rejects.toBeInstanceOf(ImportError);
    await expect(estimateImport(zip, { usage: 0, quota: 1 }, { maxEntries: 2 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });
});
