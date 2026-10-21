import { describe, expect, test } from 'vitest';
import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { ZipLimitError, openZipEntry, readZipEntries, readZipEntryBytes } from './zip';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Build a ZIP with data descriptors (sizes after the data), like phone exports. */
function streamedZip(files: Array<{ name: string; data: Uint8Array; store?: boolean }>): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    chunks.push(chunk);
  });
  for (const f of files) {
    const entry = f.store ? new ZipPassThrough(f.name) : new ZipDeflate(f.name);
    zip.add(entry);
    entry.push(f.data, true);
  }
  zip.end();
  return concat(chunks);
}

/** Hand-built ZIP64 archive (stored entries, all sizes/offsets in the 0x0001 extra field). */
function zip64(files: Array<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const lh = new Uint8Array(30 + name.length + 20);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 45, true);
    lv.setUint32(18, 0xffffffff, true);
    lv.setUint32(22, 0xffffffff, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 20, true);
    lh.set(name, 30);
    lv.setUint16(30 + name.length, 0x0001, true);
    lv.setUint16(32 + name.length, 16, true);
    lv.setBigUint64(34 + name.length, BigInt(f.data.length), true);
    lv.setBigUint64(42 + name.length, BigInt(f.data.length), true);

    const ch = new Uint8Array(46 + name.length + 28);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 45, true);
    cv.setUint16(6, 45, true);
    cv.setUint32(20, 0xffffffff, true);
    cv.setUint32(24, 0xffffffff, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 28, true);
    cv.setUint32(42, 0xffffffff, true);
    ch.set(name, 46);
    const e = 46 + name.length;
    cv.setUint16(e, 0x0001, true);
    cv.setUint16(e + 2, 24, true);
    cv.setBigUint64(e + 4, BigInt(f.data.length), true); // uncompressed
    cv.setBigUint64(e + 12, BigInt(f.data.length), true); // compressed
    cv.setBigUint64(e + 20, BigInt(offset), true); // local header offset
    central.push(ch);

    parts.push(lh, f.data);
    offset += lh.length + f.data.length;
  }
  const cd = concat(central);
  const cdOffset = offset;
  const eocd64 = new Uint8Array(56);
  const e64 = new DataView(eocd64.buffer);
  e64.setUint32(0, 0x06064b50, true);
  e64.setBigUint64(4, 44n, true);
  e64.setBigUint64(24, BigInt(files.length), true);
  e64.setBigUint64(32, BigInt(files.length), true);
  e64.setBigUint64(40, BigInt(cd.length), true);
  e64.setBigUint64(48, BigInt(cdOffset), true);
  const locator = new Uint8Array(20);
  const lo = new DataView(locator.buffer);
  lo.setUint32(0, 0x07064b50, true);
  lo.setBigUint64(8, BigInt(cdOffset + cd.length), true);
  lo.setUint32(16, 1, true);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 0xffff, true);
  ev.setUint16(10, 0xffff, true);
  ev.setUint32(12, 0xffffffff, true);
  ev.setUint32(16, 0xffffffff, true);
  return concat([...parts, cd, eocd64, locator, eocd]);
}

describe('readZipEntries / openZipEntry', () => {
  test('lists and inflates deflated and stored entries', async () => {
    const zip = new Blob([
      zipSync({
        'chat/_chat.txt': [strToU8('hello world'.repeat(50)), { level: 9 }],
        'chat/IMG-1.jpg': [new Uint8Array([1, 2, 3, 4]), { level: 0 }],
      }),
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['chat/_chat.txt', 'chat/IMG-1.jpg']);
    expect(entries[0].compression).toBe(8);
    expect(entries[1].compression).toBe(0);
    expect(text(await readZipEntryBytes(zip, entries[0]))).toBe('hello world'.repeat(50));
    expect([...(await readZipEntryBytes(zip, entries[1]))]).toEqual([1, 2, 3, 4]);
  });

  test('regression: stored inner .zip with data descriptors stays ONE entry', async () => {
    // fflate's forward-only `Unzip` splits this archive into
    // [inner.zip, a.txt, b.txt, _chat.txt]; the central directory does not.
    const inner = zipSync({ 'a.txt': strToU8('hello'), 'b.txt': strToU8('world') }, { level: 0 });
    const zip = new Blob([
      streamedZip([
        { name: 'inner.zip', data: inner, store: true },
        { name: '_chat.txt', data: strToU8('[01/01/2026 10:00:00] A: hi') },
      ]),
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['inner.zip', '_chat.txt']);
    expect([...(await readZipEntryBytes(zip, entries[0]))]).toEqual([...inner]);
    expect(text(await readZipEntryBytes(zip, entries[1]))).toBe('[01/01/2026 10:00:00] A: hi');
  });

  test('reads ZIP64 archives (EOCD64 + 0x0001 extra fields)', async () => {
    const zip = new Blob([
      zip64([
        { name: '_chat.txt', data: strToU8('line one\nline two') },
        { name: 'PTT-1.opus', data: new Uint8Array([9, 8, 7]) },
      ]),
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => [e.name, e.compressedSize, e.uncompressedSize])).toEqual([
      ['_chat.txt', 17, 17],
      ['PTT-1.opus', 3, 3],
    ]);
    expect(text(await readZipEntryBytes(zip, entries[0]))).toBe('line one\nline two');
    expect([...(await readZipEntryBytes(zip, entries[1]))]).toEqual([9, 8, 7]);
  });

  test('streams large entries in several chunks', async () => {
    // Incompressible bytes, so the compressed range spans many blob chunks.
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
    const bytes = zipSync({ 'VID.mp4': [big, { level: 6 }] });
    // A multi-part Blob streams part by part, like a file read in chunks.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 65536) parts.push(bytes.subarray(i, i + 65536));
    const zip = new Blob(parts as BlobPart[]);
    const [entry] = await readZipEntries(zip);
    const out = new Uint8Array(big.length);
    let total = 0;
    let chunks = 0;
    const reader = openZipEntry(zip, entry).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, total);
      total += value.length;
      chunks += 1;
    }
    expect(total).toBe(big.length);
    expect(out).toEqual(big);
    expect(chunks).toBeGreaterThan(1);
  });

  test('rejects a non-ZIP input', async () => {
    await expect(readZipEntries(new Blob(['not a zip at all']))).rejects.toThrow(
      /end-of-central-directory/,
    );
  });

  test('unsupported compression errors the entry stream', async () => {
    const zip = new Blob([zipSync({ 'a.txt': strToU8('abc') })]);
    const [entry] = await readZipEntries(zip);
    await expect(readZipEntryBytes(zip, { ...entry, compression: 12 })).rejects.toThrow(
      /Unsupported ZIP compression method 12/,
    );
  });

  test('a bad local header offset errors the entry stream', async () => {
    const zip = new Blob([zipSync({ 'a.txt': strToU8('abc') })]);
    const [entry] = await readZipEntries(zip);
    await expect(readZipEntryBytes(zip, { ...entry, localHeaderOffset: 5 })).rejects.toThrow(
      /local header missing/,
    );
  });

  test('rejects a declared entry count above maxEntries before reading the directory', async () => {
    const zip = new Blob([zipSync({ 'a.txt': strToU8('a'), 'b.txt': strToU8('b'), 'c.txt': strToU8('c') })]);
    expect(await readZipEntries(zip, { maxEntries: 3 })).toHaveLength(3);
    await expect(readZipEntries(zip, { maxEntries: 2 })).rejects.toBeInstanceOf(ZipLimitError);
  });

  test('rejects a ZIP64 count (u64) above maxEntries', async () => {
    const bytes = zip64([{ name: 'a.txt', data: new Uint8Array([1]) }]);
    const view = new DataView(bytes.buffer);
    const at = bytes.length - 22 - 20 - 56; // EOCD64 record
    expect(view.getUint32(at, true)).toBe(0x06064b50);
    view.setBigUint64(at + 32, 5_000_000_000n, true);
    await expect(readZipEntries(new Blob([bytes]), { maxEntries: 1_000_000 })).rejects.toBeInstanceOf(ZipLimitError);
  });

  test('rejects a central directory above maxCentralDirectoryBytes', async () => {
    const zip = new Blob([zipSync({ 'a.txt': strToU8('a') })]);
    await expect(readZipEntries(zip, { maxCentralDirectoryBytes: 10 })).rejects.toBeInstanceOf(ZipLimitError);
    expect(await readZipEntries(zip, { maxCentralDirectoryBytes: 10_000 })).toHaveLength(1);
  });

  test('a count that cannot fit in the declared directory is corrupt', async () => {
    const bytes = zipSync({ 'a.txt': strToU8('a') });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(bytes.length - 22 + 10, 60000, true);
    await expect(readZipEntries(new Blob([bytes as BlobPart]))).rejects.toThrow(/corrupt/);
  });
});

describe('openZipEntry output bound', () => {
  test('an entry that inflates beyond the size its directory declares is stopped', async () => {
    const bomb = zipSync({ 'big.bin': [new Uint8Array(2_000_000), { level: 9 }] });
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    let cd = bomb.length - 22;
    while (view.getUint32(cd, true) !== 0x02014b50) cd--;
    view.setUint32(cd + 24, 1000, true); // the directory lies: 1000 bytes
    const blob = new Blob([bomb as BlobPart]);
    const [entry] = await readZipEntries(blob);
    await expect(readZipEntryBytes(blob, entry)).rejects.toBeInstanceOf(ZipLimitError);
  });

  test('an honest entry is read completely', async () => {
    const blob = new Blob([zipSync({ 'ok.bin': [new Uint8Array(70_000).fill(7), { level: 6 }] }) as BlobPart]);
    const [entry] = await readZipEntries(blob);
    expect((await readZipEntryBytes(blob, entry)).length).toBe(70_000);
  });
});
