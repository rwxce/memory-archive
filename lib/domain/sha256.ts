/**
 * Incremental SHA-256 (FIPS 180-4) in plain TypeScript.
 *
 * Why it exists: WebCrypto's `crypto.subtle.digest` is one-shot (it needs the whole input
 * in memory), but media is hashed while it streams out of a ZIP so a large video never
 * has to fit in RAM. No dependency, no I/O, runs unchanged in the browser, a worker and Node.
 * The output is the content address of a blob, so it must never change: the NIST test
 * vectors in `sha256.test.ts` pin it.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

export interface Sha256 {
  /** Feed more bytes. Throws after `digestHex()`. */
  update(chunk: Uint8Array): void;
  /** Finish and return 64 lowercase hex characters. Calling it again returns the same value. */
  digestHex(): string;
}

export function createSha256(): Sha256 {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const pending = new Uint8Array(64);
  let pendingLength = 0;
  let totalBytes = 0;
  let digest: string | undefined;

  function compress(data: Uint8Array, offset: number): void {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const bigS1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + bigS1 + ch + K[i] + w[i]) | 0;
      const bigS0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigS0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  return {
    update(chunk) {
      if (digest !== undefined) throw new Error('sha256: update after digest');
      totalBytes += chunk.length;
      let i = 0;
      if (pendingLength > 0) {
        const take = Math.min(64 - pendingLength, chunk.length);
        pending.set(chunk.subarray(0, take), pendingLength);
        pendingLength += take;
        i = take;
        if (pendingLength < 64) return;
        compress(pending, 0);
        pendingLength = 0;
      }
      for (; i + 64 <= chunk.length; i += 64) compress(chunk, i);
      if (i < chunk.length) {
        pending.set(chunk.subarray(i), 0);
        pendingLength = chunk.length - i;
      }
    },
    digestHex() {
      if (digest !== undefined) return digest;
      pending[pendingLength++] = 0x80;
      if (pendingLength > 56) {
        pending.fill(0, pendingLength);
        compress(pending, 0);
        pendingLength = 0;
      }
      pending.fill(0, pendingLength, 56);
      // Message length in bits as a 64-bit big-endian integer (exact below 2^53 bytes).
      const bitsHigh = Math.floor(totalBytes / 0x20000000);
      const bitsLow = (totalBytes << 3) >>> 0;
      for (let k = 0; k < 4; k++) {
        pending[56 + k] = (bitsHigh >>> (24 - 8 * k)) & 0xff;
        pending[60 + k] = (bitsLow >>> (24 - 8 * k)) & 0xff;
      }
      compress(pending, 0);
      let hex = '';
      for (const word of h) hex += word.toString(16).padStart(8, '0');
      digest = hex;
      return hex;
    },
  };
}

/** One-shot convenience for in-memory input. */
export function sha256Hex(bytes: Uint8Array): string {
  const hasher = createSha256();
  hasher.update(bytes);
  return hasher.digestHex();
}
