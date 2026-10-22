import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Guard: real chat data must never come back into the (public) repository.
//
// 1. Any 11-digit run (plain or `000.000.000-00`) whose two check digits are a valid Brazilian
//    CPF fails. Synthetic fixtures use numbers that are NOT valid CPFs.
// 2. A denylist of real names, credentials and phone fragments that were scrubbed from the repo.
//    It stores only sha256 hashes of normalized word sequences, so this file does not
//    reintroduce the data it guards against. To extend it, hash `normalize(phrase)` (below).
//
// Scans every git-tracked text file except this one. Add new synthetic data to
// scripts/generate-fixtures.mjs, never real exports.

const SELF = 'scripts/no-real-data.test.ts';
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.css', '.html', '.csv', '.svg']);
const SKIP = new Set(['pnpm-lock.yaml']);
const MAX_BYTES = 1_000_000;

/** sha256 of normalized 1-3 word sequences (lowercase, no diacritics, `[a-z0-9]+` words). */
const DENYLIST = new Set([
  'd7e683b2403ea9c106e7fd5bca3488d44f0b7fa1e6617368a34035f0f9af5158',
  'f99ea984b0ce642c24bbc8c6375cb70e2beae5509bff875ac2a6629b8f66b5e3',
  '0c14a74beda500b376209721099235774c1227ab192df3730d41f46caccfd279',
  '91d11f0be29816d485c012e4bd3bb140d63f5fc439fc3db1aa3bdd5fb3916fe0',
  '7a486f11b9cd4a9c392a67617b6d708ca0f4eea51b616eabb0e93332dd04e4b6',
  '5fd9763d6055dac9fb1dceb442dc3b58f7b7d8023419a483e38a168b2351659d',
  'e18c98cf767b1e7037677ff484d11562c97b1340ea7595f0d30e0f0df830dbdb',
  '85bf8c039412639f08d0646e972b14b9f194c367cc4bff7c2bb48c3fa65cb587',
  '1b9d68024d067340d2494c902bbc4617ec5fcedd5ee1e796b1c9a774c3f5a0ea',
  '92e32ed9e4483e6c402caaff3c1c4439442802dfef1926fa2708a838e8ef2acb',
  'c8779e4aab5ed6d6d3188d51180954c50bce929443679dae241a13032ab4a28e',
  'b2a5ec5043fa336ddbbb0328b857bfde442b795599cd353add9a8d1f9c997543',
  '928b5e444f8459fbbf27e541c7c09664d0548b09fdd94ab8f05b33487fd705b3',
  '4e6a4cc87abf34e8e33062463a0e6234422fafaa1dd8a84a9501b01e014e4327',
  'cc0d6679275a3cf2c5b0d850f9ed9601d66a331537b0c4d561d61ba973e497a4',
  '3d65cd5128f2a273014f45b33a360ff02eeebe7c244d0cfb6165028455b48a59',
  '88566af41b3913cc49196b3f6b81aeb738516d31ebdbc0fe6656a8d7dbf6f583',
]);

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Lowercase words without diacritics: `Conexão_WK-1` -> ['conexao', 'wk', '1']. */
function words(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Brazilian CPF check digits (11 digits, not all equal). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

function cpfWithChecks(base9: string): string {
  const calc = (digits: string): number => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (digits.length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const d1 = calc(base9);
  return base9 + d1 + calc(base9 + d1);
}

function findCpfs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g)) {
    const digits = m[1].replace(/\D/g, '');
    if (isValidCpf(digits)) out.push(m[1]);
  }
  return out;
}

function findDenied(text: string): number {
  const w = words(text);
  let hits = 0;
  for (let i = 0; i < w.length; i++) {
    let phrase = '';
    for (let n = 0; n < 3 && i + n < w.length; n++) {
      phrase = n === 0 ? w[i] : `${phrase} ${w[i + n]}`;
      if (DENYLIST.has(sha256(phrase))) hits++;
    }
  }
  return hits;
}

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return out
    .split('\0')
    .filter((f) => f && f !== SELF && !SKIP.has(f) && TEXT_EXT.has(path.extname(f).toLowerCase()));
}

describe('guard helpers', () => {
  test('isValidCpf accepts computed check digits and rejects wrong ones', () => {
    const valid = cpfWithChecks('123456789');
    expect(isValidCpf(valid)).toBe(true);
    expect(findCpfs(`x-${valid}-y`)).toEqual([valid]);
    expect(findCpfs(`${valid.slice(0, 3)}.${valid.slice(3, 6)}.${valid.slice(6, 9)}-${valid.slice(9)}`)).toHaveLength(1);
    // The synthetic fixture number must stay an invalid CPF.
    expect(isValidCpf('12345678900')).toBe(false);
    expect(isValidCpf('00000000000')).toBe(false);
    expect(findCpfs(`${valid}0`)).toEqual([]); // 12 digits is not an 11-digit run
  });

  test('the denylist matches normalized phrases across case, accents and separators', () => {
    expect(findDenied('nothing to see here')).toBe(0);
    // Hashes of the synthetic placeholders must never be in the denylist.
    for (const phrase of ['alice example', 'example org', 'bob sample', 'carol sample', 'example network']) {
      expect(DENYLIST.has(sha256(phrase))).toBe(false);
    }
  });
});

describe('no real personal data in tracked files', () => {
  const files = trackedTextFiles();

  test('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test('no valid CPF numbers and no denylisted real data', () => {
    const problems: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        if (fs.statSync(file).size > MAX_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // listed by git but deleted in the working tree
      }
      // Report file names only, never the matched content.
      if (findCpfs(text).length > 0) problems.push(`${file}: valid CPF number`);
      if (findDenied(text) > 0) problems.push(`${file}: denylisted real data`);
    }
    expect(problems).toEqual([]);
  });
});
