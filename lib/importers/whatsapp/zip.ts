import { Inflate } from 'fflate';

/**
 * Platform-neutral ZIP reader over a `Blob` (a browser `File`, or a Node
 * `fs.openAsBlob()` handle). It is the single ZIP reader of the project: the
 * chat transcript and every media entry go through it.
 *
 * Layout comes from the **central directory** (with ZIP64), not from the local
 * headers: WhatsApp exports store members with data descriptors (sizes only
 * after the data), and a forward-only streaming reader such as fflate's
 * `Unzip` has to guess where such a member ends by scanning for the next
 * signature. A stored inner `.zip` attachment contains those signatures, so the
 * streaming reader splits it into bogus entries. Reading the central directory
 * avoids the guess, and `Blob.slice()` gives random access without loading
 * the archive into memory. Entry bytes are streamed and inflated with fflate's
 * streaming `Inflate`.
 */

export interface ZipEntry {
  /** Entry path inside the archive, as stored (UTF-8 decoded). */
  name: string;
  /** 0 = stored, 8 = deflate. */
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the entry's local file header. */
  localHeaderOffset: number;
  crc32: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const utf8 = new TextDecoder('utf-8');

async function readRange(blob: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > blob.size || start > end) {
    throw new Error('ZIP structure points outside the file');
  }
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

function u64(view: DataView, offset: number): number {
  const v = view.getBigUint64(offset, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 value too large');
  return Number(v);
}

/** The central directory declares more entries or bytes than the caller allows. */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export interface ReadZipOptions {
  /** Reject a declared entry count above this, before the directory is read. */
  maxEntries?: number;
  /** Reject a declared central directory size above this, before it is read. */
  maxCentralDirectoryBytes?: number;
}

/**
 * List all entries from the central directory. Throws on a non-ZIP input, and a
 * `ZipLimitError` when the declared count or directory size exceeds the options
 * (checked on the declared values, so nothing big is read or allocated).
 */
export async function readZipEntries(zip: Blob, options: ReadZipOptions = {}): Promise<ZipEntry[]> {
  const tailLen = Math.min(zip.size, EOCD_MIN + MAX_COMMENT);
  const tailStart = zip.size - tailLen;
  const tail = await readRange(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tailLen - EOCD_MIN; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    // ZIP64: the locator sits right before the classic EOCD record.
    const locAt = eocd - 20;
    if (locAt < 0 || tail.getUint32(locAt, true) !== SIG_EOCD64_LOCATOR) {
      throw new Error('ZIP64 end-of-central-directory locator not found');
    }
    const eocd64Offset = u64(tail, locAt + 8);
    const rec = await readRange(zip, eocd64Offset, eocd64Offset + 56);
    if (rec.getUint32(0, true) !== SIG_EOCD64) {
      throw new Error('ZIP64 end-of-central-directory record not found');
    }
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }

  if (options.maxEntries !== undefined && count > options.maxEntries) {
    throw new ZipLimitError('ZIP declares too many entries');
  }
  if (options.maxCentralDirectoryBytes !== undefined && cdSize > options.maxCentralDirectoryBytes) {
    throw new ZipLimitError('ZIP central directory is too large');
  }
  // Every record takes at least 46 bytes: a larger count cannot be real.
  if (count * 46 > cdSize) throw new Error('ZIP central directory is corrupt');

  const cd = await readRange(zip, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error('ZIP central directory is corrupt');
    }
    const compression = cd.getUint16(p + 10, true);
    const crc32 = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let uncompressedSize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localHeaderOffset = cd.getUint32(p + 42, true);
    const nameStart = p + 46;
    const name = utf8.decode(
      new Uint8Array(cd.buffer, cd.byteOffset + nameStart, nameLen),
    );

    // ZIP64 extended information extra field (0x0001): only the fields whose
    // classic value is 0xFFFFFFFF are present, in this fixed order.
    let e = nameStart + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const size = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === U32_MAX) {
          uncompressedSize = u64(cd, q);
          q += 8;
        }
        if (compressedSize === U32_MAX) {
          compressedSize = u64(cd, q);
          q += 8;
        }
        if (localHeaderOffset === U32_MAX) {
          localHeaderOffset = u64(cd, q);
        }
      }
      e += 4 + size;
    }

    entries.push({
      name,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32,
    });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** Byte offset where an entry's (compressed) data starts. */
async function dataOffset(zip: Blob, entry: ZipEntry): Promise<number> {
  const lh = await readRange(zip, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (lh.getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(`ZIP local header missing for ${entry.name}`);
  }
  const nameLen = lh.getUint16(26, true);
  const extraLen = lh.getUint16(28, true);
  return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

/** Raw-DEFLATE decompression as a web `TransformStream` (fflate). */
function inflateRaw(): TransformStream<Uint8Array, Uint8Array> {
  let inflater: Inflate;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      inflater = new Inflate((chunk) => {
        if (chunk.length) controller.enqueue(chunk);
      });
    },
    transform(chunk) {
      inflater.push(chunk, false);
    },
    flush() {
      inflater.push(new Uint8Array(0), true);
    },
  });
}

/**
 * Stream one entry's uncompressed bytes. Only that entry's byte range is read
 * from the blob, in chunks; nothing else in the archive is touched.
 */
export function openZipEntry(zip: Blob, entry: ZipEntry): ReadableStream<Uint8Array> {
  if (entry.compression !== 0 && entry.compression !== 8) {
    return new ReadableStream({
      start(controller) {
        controller.error(
          new Error(`Unsupported ZIP compression method ${entry.compression} for ${entry.name}`),
        );
      },
    });
  }
  const sink =
    entry.compression === 8
      ? inflateRaw()
      : new TransformStream<Uint8Array, Uint8Array>();
  dataOffset(zip, entry)
    .then((start) => {
      const end = start + entry.compressedSize;
      if (end > zip.size) throw new Error(`ZIP entry ${entry.name} is truncated`);
      return zip.slice(start, end).stream().pipeTo(sink.writable);
    })
    .catch((err: unknown) => {
      // pipeTo already errored the writable on stream failures; this covers
      // header errors that happen before piping starts.
      sink.writable.abort(err).catch(() => undefined);
    });
  return sink.readable;
}

/** Read a (small) entry fully into memory. */
export async function readZipEntryBytes(zip: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const buf = await new Response(openZipEntry(zip, entry)).arrayBuffer();
  return new Uint8Array(buf);
}
