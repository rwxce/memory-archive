import { ArchiveError } from './format';

/*
 * Optional password encryption of a backup. The envelope wraps the backup ZIP's bytes unchanged.
 * The format is specified in `docs/formats/encrypted-backup.md`; keep the two in step.
 *
 *   header (44 bytes, authenticated as AAD of every chunk)
 *     0   8  magic "MABACKUP"
 *     8   1  envelope version (1)
 *     9   1  KDF id (1 = PBKDF2-HMAC-SHA-256)
 *     10  2  reserved, zero
 *     12  4  PBKDF2 iterations, big endian
 *     16  4  plaintext chunk size in bytes, big endian
 *     20 16  salt
 *     36  8  IV base
 *   key check: one sealed chunk (index 0xFFFFFFFF, final) of a constant, 16 + 16 bytes
 *   chunks: ciphertext + 16-byte tag; all full-size (chunk size + 16) except the last
 *
 * AES-256-GCM per chunk. IV = IV base (8) || chunk index (4, big endian). AAD = header || index (4)
 * || final flag (1). The salt is random per file, so a key is never used in two files.
 */

export const ENCRYPTED_MAGIC = 'MABACKUP';
export const ENVELOPE_VERSION = 1;
const KDF_PBKDF2_SHA256 = 1;
const HEADER_BYTES = 44;
const SALT_BYTES = 16;
const IV_BASE_BYTES = 8;
const TAG_BYTES = 16;
const KEY_CHECK_INDEX = 0xffffffff;
const KEY_CHECK_PLAINTEXT = new TextEncoder().encode('memory-archive-ok');
const KEY_CHECK_BYTES = KEY_CHECK_PLAINTEXT.length + TAG_BYTES;
/** Where the first data chunk starts. */
const BODY_OFFSET = HEADER_BYTES + KEY_CHECK_BYTES;

export const DEFAULT_ITERATIONS = 600_000;
/** Bounds applied to an untrusted header: the CPU a file may demand, and the memory of one chunk. */
export const MIN_ITERATIONS = 10_000;
export const MAX_ITERATIONS = 2_000_000;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** A tiny chunk size would make a hostile file cost one WebCrypto call per few bytes. */
export const MIN_CHUNK_BYTES = 4096;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Sealed chunks are folded into a sub-`Blob` this often so the JS heap does not hold the whole output. */
const FLUSH_BYTES = 16 * 1024 * 1024;

export interface CryptoProgress {
  /** Plaintext bytes processed so far / in total. */
  done: number;
  total: number;
}

export interface EncryptOptions {
  /** Tests lower these to stay fast; the app uses the defaults. */
  iterations?: number;
  chunkBytes?: number;
  onProgress?: (progress: CryptoProgress) => void;
  /** Checked between chunks; rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface DecryptOptions {
  onProgress?: (progress: CryptoProgress) => void;
  signal?: AbortSignal;
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ArchiveError('encryption-unavailable', 'this browser cannot encrypt here (WebCrypto needs a secure context)');
  return s;
};

const u32 = (view: DataView, offset: number) => view.getUint32(offset, false);

/** NFC so the same password typed on another keyboard or OS derives the same key; nothing else is changed (no trim, no case folding). */
const passwordBytes = (password: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(password.normalize('NFC'));

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const s = subtle();
  const material = await s.importKey('raw', passwordBytes(password), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const ivFor = (header: Uint8Array, index: number): Uint8Array<ArrayBuffer> => {
  const iv = new Uint8Array(12);
  iv.set(header.subarray(36, 36 + IV_BASE_BYTES), 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
};

const aadFor = (header: Uint8Array, index: number, final: boolean): Uint8Array<ArrayBuffer> => {
  const aad = new Uint8Array(HEADER_BYTES + 5);
  aad.set(header, 0);
  const view = new DataView(aad.buffer);
  view.setUint32(HEADER_BYTES, index, false);
  view.setUint8(HEADER_BYTES + 4, final ? 1 : 0);
  return aad;
};

const seal = async (key: CryptoKey, header: Uint8Array, index: number, final: boolean, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: ivFor(header, index), additionalData: aadFor(header, index, final), tagLength: 128 }, key, data));

const open = async (key: CryptoKey, header: Uint8Array, index: number, final: boolean, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: ivFor(header, index), additionalData: aadFor(header, index, final), tagLength: 128 }, key, data));

const aborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw signal.reason;
};

/** Whether `file` starts with the encrypted-backup magic (a ZIP starts with `PK`). Reads 8 bytes. */
export async function isEncryptedBackup(file: Blob): Promise<boolean> {
  if (file.size < ENCRYPTED_MAGIC.length) return false;
  const head = new Uint8Array(await file.slice(0, ENCRYPTED_MAGIC.length).arrayBuffer());
  return ENCRYPTED_MAGIC.split('').every((c, i) => head[i] === c.charCodeAt(0));
}

/** Throws what `encryptBackup` would, so a caller can fail before doing expensive work. */
export function assertCanEncrypt(password: string): void {
  if (password.length === 0) throw new ArchiveError('password-required', 'an empty password cannot protect a backup');
  subtle();
}

/**
 * Seals `plain` (the backup ZIP) with a key derived from `password`. Reads it as 1 MiB slices and
 * returns a `Blob` of the sealed parts; no single buffer holds the whole file. Rejects with the
 * signal's reason when aborted, `encryption-unavailable` without WebCrypto, and `password-required`
 * for an empty password.
 */
export async function encryptBackup(plain: Blob, password: string, options: EncryptOptions = {}): Promise<Blob> {
  assertCanEncrypt(password);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new RangeError('iterations out of range');
  if (!Number.isInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) throw new RangeError('chunk size out of range');
  const chunkCount = Math.max(1, Math.ceil(plain.size / chunkBytes));
  if (chunkCount >= KEY_CHECK_INDEX) throw new ArchiveError('limit-exceeded', 'the backup is too large to encrypt');

  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode(ENCRYPTED_MAGIC), 0);
  header[8] = ENVELOPE_VERSION;
  header[9] = KDF_PBKDF2_SHA256;
  const view = new DataView(header.buffer);
  view.setUint32(12, iterations, false);
  view.setUint32(16, chunkBytes, false);
  globalThis.crypto.getRandomValues(header.subarray(20, 20 + SALT_BYTES));
  globalThis.crypto.getRandomValues(header.subarray(36, 36 + IV_BASE_BYTES));

  aborted(options.signal);
  const key = await deriveKey(password, header.slice(20, 20 + SALT_BYTES), iterations);
  const keyCheck = await seal(key, header, KEY_CHECK_INDEX, true, KEY_CHECK_PLAINTEXT.slice());

  const folded: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [header, keyCheck];
  let pendingBytes = 0;
  options.onProgress?.({ done: 0, total: plain.size });
  for (let index = 0; index < chunkCount; index++) {
    aborted(options.signal);
    const start = index * chunkBytes;
    const slice = new Uint8Array(await plain.slice(start, Math.min(plain.size, start + chunkBytes)).arrayBuffer());
    const sealed = await seal(key, header, index, index === chunkCount - 1, slice);
    pending.push(sealed);
    pendingBytes += sealed.length;
    if (pendingBytes >= FLUSH_BYTES) {
      folded.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
    options.onProgress?.({ done: Math.min(plain.size, start + chunkBytes), total: plain.size });
  }
  folded.push(new Blob(pending));
  return new Blob(folded, { type: 'application/octet-stream' });
}

const damaged = (what: string, cause?: unknown) => new ArchiveError('integrity', `the encrypted backup is damaged (${what})`, { cause });

/**
 * Opens an encrypted backup and returns the original ZIP bytes as a `Blob` of parts. Every chunk
 * is authenticated before anything is returned, so truncation, reordering, swapped chunks and
 * flipped bits are all refused. Rejects with `ArchiveError`:
 * `not-an-archive` (no magic), `newer-format` (envelope version), `limit-exceeded` (iterations or
 * chunk size beyond the bounds), `wrong-password` (the key check failed: wrong password, or a
 * header damaged in a way that changes the key), `integrity` (anything else wrong with the bytes),
 * `encryption-unavailable`; or the signal's reason when aborted.
 */
export async function decryptBackup(encrypted: Blob, password: string, options: DecryptOptions = {}): Promise<Blob> {
  if (!(await isEncryptedBackup(encrypted))) throw new ArchiveError('not-an-archive', 'this file is not an encrypted backup');
  if (password.length === 0) throw new ArchiveError('password-required', 'a password is needed to open this backup');
  if (encrypted.size < BODY_OFFSET) throw damaged('too short');
  const header = new Uint8Array(await encrypted.slice(0, HEADER_BYTES).arrayBuffer());
  const view = new DataView(header.buffer);
  if (header[8] > ENVELOPE_VERSION) throw new ArchiveError('newer-format', 'this backup was made by a newer version of the app');
  if (header[8] !== ENVELOPE_VERSION || header[9] !== KDF_PBKDF2_SHA256) throw damaged('unknown header');
  const iterations = u32(view, 12);
  const chunkBytes = u32(view, 16);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) {
    throw new ArchiveError('limit-exceeded', 'the encrypted backup asks for more work than this app allows');
  }

  aborted(options.signal);
  const key = await deriveKey(password, header.slice(20, 20 + SALT_BYTES), iterations);
  try {
    const keyCheck = new Uint8Array(await encrypted.slice(HEADER_BYTES, BODY_OFFSET).arrayBuffer());
    await open(key, header, KEY_CHECK_INDEX, true, keyCheck);
  } catch (cause) {
    if (cause instanceof ArchiveError) throw cause;
    throw new ArchiveError('wrong-password', 'wrong password, or the backup header is damaged', { cause });
  }

  const sealedChunk = chunkBytes + TAG_BYTES;
  const bodyBytes = encrypted.size - BODY_OFFSET;
  const chunkCount = Math.ceil(bodyBytes / sealedChunk);
  const lastBytes = bodyBytes - (chunkCount - 1) * sealedChunk;
  if (chunkCount < 1 || lastBytes < TAG_BYTES) throw damaged('truncated');
  const total = bodyBytes - chunkCount * TAG_BYTES;

  const folded: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let done = 0;
  options.onProgress?.({ done, total });
  for (let index = 0; index < chunkCount; index++) {
    aborted(options.signal);
    const start = BODY_OFFSET + index * sealedChunk;
    const data = new Uint8Array(await encrypted.slice(start, Math.min(encrypted.size, start + sealedChunk)).arrayBuffer());
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = await open(key, header, index, index === chunkCount - 1, data);
    } catch (cause) {
      if (cause instanceof ArchiveError) throw cause;
      throw damaged(`chunk ${index}`, cause);
    }
    pending.push(plain);
    pendingBytes += plain.length;
    done += plain.length;
    if (pendingBytes >= FLUSH_BYTES) {
      folded.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
    options.onProgress?.({ done, total });
  }
  folded.push(new Blob(pending));
  return new Blob(folded);
}

/** The plaintext as it is, or the decrypted backup when `file` is encrypted. `password-required` when it is and none is given. */
export async function openBackupBlob(file: Blob, password: string | undefined, options: DecryptOptions = {}): Promise<Blob> {
  if (!(await isEncryptedBackup(file))) return file;
  if (!password) throw new ArchiveError('password-required', 'this backup is encrypted; a password is needed');
  return decryptBackup(file, password, options);
}
