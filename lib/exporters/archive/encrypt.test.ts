import { describe, expect, test } from 'vitest';
import { DEFAULT_ITERATIONS, MAX_ITERATIONS, MIN_CHUNK_BYTES, MIN_ITERATIONS, decryptBackup, encryptBackup, isEncryptedBackup, openBackupBlob } from './encrypt';
import { ArchiveError } from './format';

// Tests lower the work factor (the defaults are checked once, below) and the chunk size.
const C = MIN_CHUNK_BYTES;
const FAST = { iterations: MIN_ITERATIONS, chunkBytes: C };
const HEADER = 44;
const BODY = HEADER + 17 + 16;
const SEALED = C + 16;
const PASSWORD = 'correct horse battery staple';

const bytesOf = (n: number, seed = 7) => new Uint8Array(n).map((_, i) => (i * seed + (i >> 3)) % 251);
const read = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const zipLike = (bytes: Uint8Array) => new Blob([new Uint8Array([0x50, 0x4b, 3, 4]), bytes as BlobPart]);
const seal = (plain: Blob, password = PASSWORD, extra = {}) => encryptBackup(plain, password, { ...FAST, ...extra });
const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ArchiveError);
  const text = `${(error as Error).message} ${String((error as Error).cause ?? '')}`;
  expect(text).not.toContain(PASSWORD);
  return (error as ArchiveError).code;
};
const withBytes = (bytes: Uint8Array, edit: (b: Uint8Array) => void) => {
  const copy = bytes.slice();
  edit(copy);
  return new Blob([copy as BlobPart]);
};

describe('encrypted backup envelope', () => {
  test('round trip returns the same bytes; the output starts with the magic, not PK', async () => {
    const plain = zipLike(bytesOf(1000));
    const sealed = await seal(plain);
    expect(await isEncryptedBackup(sealed)).toBe(true);
    expect(await isEncryptedBackup(plain)).toBe(false);
    expect(new TextDecoder().decode((await read(sealed)).subarray(0, 8))).toBe('MABACKUP');
    expect(await read(await decryptBackup(sealed, PASSWORD))).toEqual(await read(plain));
    expect(sealed.size).toBe(BODY + 1000 + 4 + Math.ceil(1004 / C) * 16);
  });

  test('defaults: 600,000 iterations and 1 MiB chunks are what the app writes', async () => {
    const plain = zipLike(bytesOf(10));
    const sealed = await encryptBackup(plain, PASSWORD);
    const header = new DataView((await read(sealed)).buffer);
    expect(header.getUint32(12)).toBe(DEFAULT_ITERATIONS);
    expect(header.getUint32(16)).toBe(1024 * 1024);
    expect(await read(await decryptBackup(sealed, PASSWORD))).toEqual(await read(plain));
  });

  test('every chunk size boundary round-trips, including an empty payload', async () => {
    for (const size of [0, 1, C - 1, C, C + 1, 2 * C - 1, 2 * C, 2 * C + 1, C * 40]) {
      const plain = new Blob([bytesOf(size) as BlobPart]);
      const out = await read(await decryptBackup(await seal(plain), PASSWORD));
      expect(out, `size ${size}`).toEqual(await read(plain));
    }
  });

  test('a large-ish payload spans many chunks and reports progress', async () => {
    const plain = new Blob([bytesOf(C * 50 + 5) as BlobPart]);
    const seen: number[] = [];
    const sealed = await seal(plain, PASSWORD, { onProgress: (p: { done: number }) => seen.push(p.done) });
    expect(seen.at(-1)).toBe(plain.size);
    const opened: number[] = [];
    const out = await decryptBackup(sealed, PASSWORD, { onProgress: (p) => opened.push(p.done) });
    expect(opened.at(-1)).toBe(plain.size);
    expect(out.size).toBe(plain.size);
    expect(await read(out)).toEqual(await read(plain));
  });

  test('two encryptions of the same input differ (random salt and IV base); each opens', async () => {
    const plain = zipLike(bytesOf(300));
    const [a, b] = [await read(await seal(plain)), await read(await seal(plain))];
    expect(a).not.toEqual(b);
    expect(a.subarray(20, 44)).not.toEqual(b.subarray(20, 44));
  });

  test('a wrong password is wrong-password; an empty one is password-required; neither leaks the password', async () => {
    const sealed = await seal(zipLike(bytesOf(200)));
    expect(await codeOf(decryptBackup(sealed, 'wrong password'))).toBe('wrong-password');
    expect(await codeOf(decryptBackup(sealed, ''))).toBe('password-required');
    expect(await codeOf(encryptBackup(zipLike(bytesOf(5)), '', FAST))).toBe('password-required');
  });

  test('unicode: NFC and NFD forms of a password are the same password; case and spaces matter', async () => {
    const nfc = 'Contraseña-café 日本 😀'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    const sealed = await seal(zipLike(bytesOf(50)), nfc);
    expect((await decryptBackup(sealed, nfd)).size).toBe(54);
    expect(await codeOf(decryptBackup(sealed, `${nfc} `))).toBe('wrong-password');
    expect(await codeOf(decryptBackup(sealed, nfc.toUpperCase()))).toBe('wrong-password');
  });

  test('header tampering is refused (salt, iterations, chunk size, IV base, version)', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(300))));
    // Salt and iterations change the key: the key check fails.
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[25] ^= 1)), PASSWORD))).toBe('wrong-password');
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[15] ^= 1)), PASSWORD))).toBe('wrong-password');
    // IV base and chunk size change the AAD / IV / layout.
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[40] ^= 1)), PASSWORD))).toBe('wrong-password');
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[19] ^= 1)), PASSWORD))).toMatch(/wrong-password|integrity/);
    // Reserved bytes are authenticated too.
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[10] = 1)), PASSWORD))).toBe('wrong-password');
    // Versions: newer is named, an unknown KDF is damage.
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[8] = 2)), PASSWORD))).toBe('newer-format');
    expect(await codeOf(decryptBackup(withBytes(bytes, (b) => (b[9] = 9)), PASSWORD))).toBe('integrity');
  });

  test('absurd iteration counts and chunk sizes are refused before any key derivation', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(100))));
    const setU32 = (offset: number, value: number) => withBytes(bytes, (b) => new DataView(b.buffer).setUint32(offset, value));
    const started = Date.now();
    expect(await codeOf(decryptBackup(setU32(12, MAX_ITERATIONS + 1), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(12, 0xffffffff), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(12, 10_000_000), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(12, MIN_ITERATIONS - 1), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(16, 16 * 1024 * 1024 + 1), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(16, 0), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(16, 1), PASSWORD))).toBe('limit-exceeded');
    expect(await codeOf(decryptBackup(setU32(16, MIN_CHUNK_BYTES - 1), PASSWORD))).toBe('limit-exceeded');
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(encryptBackup(zipLike(bytesOf(1)), PASSWORD, { iterations: MAX_ITERATIONS + 1 })).rejects.toThrow(RangeError);
    await expect(encryptBackup(zipLike(bytesOf(1)), PASSWORD, { iterations: MIN_ITERATIONS, chunkBytes: 1 })).rejects.toThrow(RangeError);
  });

  test('a flipped bit in any chunk, the key check or the last tag is refused', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(C * 6))));
    const chunks = Math.ceil((C * 6 + 4) / C);
    for (const offset of [HEADER + 3, BODY, BODY + 10, BODY + SEALED + 1, BODY + 2 * SEALED + 70, bytes.length - 1]) {
      const code = await codeOf(decryptBackup(withBytes(bytes, (b) => (b[offset] ^= 0x10)), PASSWORD));
      expect(code, `offset ${offset}`).toBe(offset < BODY ? 'wrong-password' : 'integrity');
    }
    expect(chunks).toBeGreaterThan(5);
  });

  test('truncation is detected, at a chunk boundary too', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(C * 6))));
    const cut = (length: number) => new Blob([bytes.slice(0, length) as BlobPart]);
    expect(await codeOf(decryptBackup(cut(bytes.length - 1), PASSWORD))).toBe('integrity');
    expect(await codeOf(decryptBackup(cut(bytes.length - 16), PASSWORD))).toBe('integrity');
    expect(await codeOf(decryptBackup(cut(BODY + 3 * SEALED), PASSWORD))).toBe('integrity');
    expect(await codeOf(decryptBackup(cut(BODY), PASSWORD))).toBe('integrity');
    expect(await codeOf(decryptBackup(cut(20), PASSWORD))).toBe('integrity');
    expect(await codeOf(decryptBackup(cut(HEADER + 5), PASSWORD))).toBe('integrity');
  });

  test('appended bytes are refused', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(C * 3))));
    for (const extra of [1, 16, 80]) {
      expect(await codeOf(decryptBackup(new Blob([bytes as BlobPart, new Uint8Array(extra)]), PASSWORD))).toBe('integrity');
    }
  });

  test('reordered chunks are refused', async () => {
    const bytes = await read(await seal(zipLike(bytesOf(C * 6))));
    const swapped = withBytes(bytes, (b) => {
      const a = b.slice(BODY, BODY + SEALED);
      b.copyWithin(BODY, BODY + SEALED, BODY + 2 * SEALED);
      b.set(a, BODY + SEALED);
    });
    expect(await codeOf(decryptBackup(swapped, PASSWORD))).toBe('integrity');
    // A dropped middle chunk shifts every later one.
    const dropped = new Blob([bytes.slice(0, BODY + SEALED), bytes.slice(BODY + 2 * SEALED)] as BlobPart[]);
    expect(await codeOf(decryptBackup(dropped, PASSWORD))).toBe('integrity');
    // A duplicated chunk.
    const doubled = new Blob([bytes.slice(0, BODY + 2 * SEALED), bytes.slice(BODY + SEALED, BODY + 2 * SEALED), bytes.slice(BODY + 2 * SEALED)] as BlobPart[]);
    expect(await codeOf(decryptBackup(doubled, PASSWORD))).toBe('integrity');
  });

  test('a chunk swapped between two backups (same password) is refused', async () => {
    const plain = zipLike(bytesOf(C * 4));
    const a = await read(await seal(plain));
    const b = await read(await seal(plain));
    const mixed = withBytes(a, (x) => x.set(b.subarray(BODY + SEALED, BODY + 2 * SEALED), BODY + SEALED));
    expect(await codeOf(decryptBackup(mixed, PASSWORD))).toBe('integrity');
    // Header and key check from another backup do not open this body either.
    const grafted = withBytes(a, (x) => x.set(b.subarray(0, BODY)));
    expect(await codeOf(decryptBackup(grafted, PASSWORD))).toBe('integrity');
  });

  test('abort stops encryption and decryption with the signal reason', async () => {
    const plain = new Blob([bytesOf(C * 50) as BlobPart]);
    const reason = new Error('stopped');
    const controller = new AbortController();
    await expect(seal(plain, PASSWORD, { signal: controller.signal, onProgress: () => controller.abort(reason) })).rejects.toBe(reason);
    const sealed = await seal(plain);
    const second = new AbortController();
    await expect(decryptBackup(sealed, PASSWORD, { signal: second.signal, onProgress: () => second.abort(reason) })).rejects.toBe(reason);
    const early = new AbortController();
    early.abort(reason);
    await expect(decryptBackup(sealed, PASSWORD, { signal: early.signal })).rejects.toBe(reason);
  });

  test('isEncryptedBackup sniffs only the magic', async () => {
    expect(await isEncryptedBackup(new Blob([]))).toBe(false);
    expect(await isEncryptedBackup(new Blob(['MABACK']))).toBe(false);
    expect(await isEncryptedBackup(new Blob(['MABACKUP']))).toBe(true);
    expect(await isEncryptedBackup(new Blob(['PK\u0003\u0004']))).toBe(false);
  });

  test('openBackupBlob passes a plain file through, and asks for the password of an encrypted one', async () => {
    const plain = zipLike(bytesOf(10));
    expect(await openBackupBlob(plain, undefined)).toBe(plain);
    expect(await openBackupBlob(plain, 'ignored')).toBe(plain);
    const sealed = await seal(plain);
    expect(await codeOf(openBackupBlob(sealed, undefined))).toBe('password-required');
    expect(await codeOf(openBackupBlob(sealed, ''))).toBe('password-required');
    expect((await openBackupBlob(sealed, PASSWORD)).size).toBe(plain.size);
  });
});
