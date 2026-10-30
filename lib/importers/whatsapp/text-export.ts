import { ZipLimitError } from './zip';

/**
 * A WhatsApp "Export chat > Without media" file is a bare `.txt`, not a ZIP. Everything after
 * the picker (preview, space estimate, import) reads an archive, so a text export is presented
 * to it as a one-entry archive: a stored (uncompressed) ZIP holding `_chat.txt`, assembled from
 * `Blob` parts (the text is read once for its CRC and never copied into memory). The chat name
 * still comes from the file name, exactly as for a ZIP, and the result has no media.
 *
 * The content decides, not the name: a ZIP is recognised by its signature and passed through
 * untouched; anything else is treated as text only when its first bytes hold no NUL byte.
 * Whether the text is a chat is left to the parser (no messages -> `invalid-export`).
 */

/** The transcript's name inside the wrapper archive (the iOS name, always found first). */
export const TEXT_EXPORT_ENTRY = '_chat.txt';

/** Bytes inspected to tell text from a binary file. */
const SNIFF_BYTES = 4096;
/** A classic (non-ZIP64) entry holds at most this many bytes. */
const MAX_CLASSIC_BYTES = 0xffffffff - SNIFF_BYTES;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

async function crc32Of(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Does this look like a ZIP (local header, or the end record of an empty one)? */
function hasZipSignature(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && (head[3] === 4 || head[3] === 6);
}

/** Is the file plain text by content: not a ZIP signature, and no NUL byte in its first bytes? */
export async function isPlainTextExport(file: Blob): Promise<boolean> {
  if (file.size === 0) return false;
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  return !hasZipSignature(head) && !head.includes(0);
}

/**
 * The archive the import reads: `file` itself when it is a ZIP (or anything that is not text, so
 * the ZIP reader reports it), otherwise a one-entry ZIP around the text. A text file larger than
 * `maxBytes` throws `ZipLimitError` (the same limit as a ZIP's `_chat.txt`: `maxChatBytes`).
 */
export async function asImportArchive(file: Blob, maxBytes: number): Promise<Blob> {
  if (!(await isPlainTextExport(file))) return file;
  if (file.size > Math.min(maxBytes, MAX_CLASSIC_BYTES)) throw new ZipLimitError('the chat transcript is too large');

  const crc = await crc32Of(file);
  const name = new TextEncoder().encode(TEXT_EXPORT_ENTRY);
  const size = file.size;

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0800, true); // UTF-8 names
  local.setUint32(14, crc, true);
  local.setUint32(18, size, true);
  local.setUint32(22, size, true);
  local.setUint16(26, name.length, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, size, true);
  central.setUint32(24, size, true);
  central.setUint16(28, name.length, true);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + name.length, true);
  end.setUint32(16, 30 + name.length + size, true);

  return new Blob([local, name, file, central, name, end], { type: 'application/zip' });
}
