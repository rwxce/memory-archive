import { describe, expect, test } from 'vitest';
import { createSha256, sha256Hex } from './sha256';

const enc = (s: string) => new TextEncoder().encode(s);

async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256', () => {
  test('NIST vectors', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(
      sha256Hex(
        enc('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'),
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  test('one million "a" fed in odd-sized chunks', () => {
    const hasher = createSha256();
    const chunk = new Uint8Array(997).fill(0x61);
    let left = 1_000_000;
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      hasher.update(chunk.subarray(0, n));
      left -= n;
    }
    expect(hasher.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  test('matches WebCrypto for every length around the padding boundaries, however it is chunked', async () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length * 7) & 0xff);
      const expected = await webCryptoHex(bytes);
      expect(sha256Hex(bytes), `length ${length}`).toBe(expected);
      const hasher = createSha256();
      for (let i = 0; i < length; i += 13) hasher.update(bytes.subarray(i, Math.min(length, i + 13)));
      expect(hasher.digestHex(), `chunked ${length}`).toBe(expected);
    }
  });

  test('digest is repeatable and update afterwards throws', () => {
    const hasher = createSha256();
    hasher.update(enc('abc'));
    const first = hasher.digestHex();
    expect(hasher.digestHex()).toBe(first);
    expect(() => hasher.update(enc('d'))).toThrow();
  });
});
