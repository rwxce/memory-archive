import { describe, expect, test } from 'vitest';
import {
  FINGERPRINT_VERSION,
  createFingerprinter,
  fingerprintOf,
  normalizeAuthor,
  normalizeMediaFileName,
  normalizeText,
  type FingerprintInput,
} from './fingerprint';

const base: FingerprintInput = {
  sentAt: '2026-03-17T13:17:59',
  author: 'Ana',
  type: 'text',
  text: 'Bon dia',
  mediaName: '',
};

describe('fingerprint test vectors (frozen: changing them is a data migration)', () => {
  test('version 1 (cross-checked against node:crypto when pinned)', () => {
    expect(FINGERPRINT_VERSION).toBe(1);
    expect(fingerprintOf(base, 0)).toBe('4577dafba224a24eb914b80fee9223bc4304437c0143d2fdc47b70f287bd8b1f');
    expect(fingerprintOf(base, 1)).toBe('77683acf6be76f81a5781388cdd5cdd22bbea7c7e13795df63a059c44c784b15');
    expect(
      fingerprintOf(
        { sentAt: '2026-03-17T13:18:00', author: '', type: 'system', text: 'Messages are end-to-end encrypted.', mediaName: '' },
        0,
      ),
    ).toBe('dc8af963c60e67efbcfca1e70edc825c38101116fbc04b3b8ca107f797b1bc49');
    expect(
      fingerprintOf(
        { sentAt: '2026-04-03T15:17:12', author: 'Bo', type: 'photo', text: 'Mira ñandú 🦤', mediaName: '00000091-PHOTO-2026-05-29-17-23-37.jpg' },
        0,
      ),
    ).toBe('640204f8b2cdf31f3720d8219a647198ab8f082eed3c441b0adf6565a1521764');
  });
});

describe('what the fingerprint ignores (stable across exports)', () => {
  const same = (change: Partial<FingerprintInput>) =>
    expect(fingerprintOf({ ...base, ...change }, 0)).toBe(fingerprintOf(base, 0));

  test('seconds: iOS (seconds) and Android (minutes) exports of one chat agree', () => {
    same({ sentAt: '2026-03-17T13:17:00' });
  });
  test('invisible marks and the ~ prefix in the author', () => {
    same({ author: '\u200e~\u00a0Ana\u200f' });
    same({ author: '\u202aAna\u202c' });
  });
  test('Unicode composition, line endings, trailing spaces', () => {
    const accented = { ...base, text: 'café\nnoi' };
    expect(fingerprintOf({ ...accented, text: 'cafe\u0301\r\nnoi  ' }, 0)).toBe(fingerprintOf(accented, 0));
  });
  test('no-break spaces and marks inside the text', () => {
    expect(fingerprintOf({ ...base, text: 'Bon\u00a0dia\u200e' }, 0)).toBe(fingerprintOf(base, 0));
  });
  test('the folder in the media reference', () => {
    const photo = { ...base, type: 'photo' as const, mediaName: 'IMG-1.jpg' };
    expect(fingerprintOf({ ...photo, mediaName: 'chat/IMG-1.jpg' }, 0)).toBe(fingerprintOf(photo, 0));
  });
});

describe('what the fingerprint distinguishes', () => {
  const differs = (change: Partial<FingerprintInput>) =>
    expect(fingerprintOf({ ...base, ...change }, 0)).not.toBe(fingerprintOf(base, 0));

  test('minute, author, type, text, media name', () => {
    differs({ sentAt: '2026-03-17T13:18:00' });
    differs({ sentAt: '2026-03-18T13:17:59' });
    differs({ author: 'Bo' });
    differs({ author: 'ana' });
    differs({ type: 'system' });
    differs({ text: 'Bon dia!' });
    differs({ mediaName: 'x.jpg' });
  });
  test('field boundaries cannot be shifted (length-prefixed)', () => {
    expect(fingerprintOf({ ...base, author: 'A', text: 'Bc' }, 0)).not.toBe(fingerprintOf({ ...base, author: 'AB', text: 'c' }, 0));
  });
  test('the occurrence index', () => {
    expect(fingerprintOf(base, 0)).not.toBe(fingerprintOf(base, 1));
  });
  test('a ZWJ is content (emoji sequences differ)', () => {
    differs({ text: 'Bon\u200ddia' });
  });
});

describe('createFingerprinter', () => {
  test('identical messages in one minute get distinct, reproducible fingerprints', () => {
    const run = () => {
      const next = createFingerprinter();
      return [next(base), next({ ...base, sentAt: '2026-03-17T13:17:05' }), next(base), next({ ...base, text: 'other' })];
    };
    const a = run();
    expect(new Set(a).size).toBe(4);
    expect(a[0]).toBe(fingerprintOf(base, 0));
    expect(a[1]).toBe(fingerprintOf(base, 1));
    expect(a[2]).toBe(fingerprintOf(base, 2));
    expect(run()).toEqual(a);
  });

  test('a newer export that extends the older one repeats its fingerprints', () => {
    const older = createFingerprinter();
    const first = [older(base), older(base)];
    const newer = createFingerprinter();
    const second = [newer(base), newer(base), newer(base)];
    expect(second.slice(0, 2)).toEqual(first);
  });

  test('rejects malformed input', () => {
    expect(() => createFingerprinter()({ ...base, sentAt: 'yesterday' })).toThrow(RangeError);
    expect(() => fingerprintOf(base, -1)).toThrow(RangeError);
    expect(() => fingerprintOf(base, 1.5)).toThrow(RangeError);
  });
});

describe('normalizers', () => {
  test('author', () => {
    expect(normalizeAuthor('\u200e+34\u202f600 11 22 33\u200f')).toBe('+34 600 11 22 33');
    expect(normalizeAuthor('  ~  Ana   Maria ')).toBe('Ana Maria');
    expect(normalizeAuthor('')).toBe('');
  });
  test('text', () => {
    expect(normalizeText('\n a  b \r\n c\t\r\n')).toBe('a  b\n c');
  });
  test('media file name', () => {
    expect(normalizeMediaFileName('a/b/IMG 1.jpg ')).toBe('IMG 1.jpg');
  });
});

/** A second, test-local implementation: hand-built bytes and WebCrypto, sharing no code with the module. */
async function independentFingerprint(fields: string[]): Promise<string> {
  const chunks: number[] = [];
  for (const field of fields) {
    const bytes = new TextEncoder().encode(field);
    chunks.push((bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes);
  }
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(chunks));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('the frozen vectors match an independent implementation', () => {
  test.each([
    ['text', ['1', '2026-03-17T13:17', 'Ana', 'text', 'Bon dia', '', '0'], '4577dafba224a24eb914b80fee9223bc4304437c0143d2fdc47b70f287bd8b1f'],
    ['second occurrence', ['1', '2026-03-17T13:17', 'Ana', 'text', 'Bon dia', '', '1'], '77683acf6be76f81a5781388cdd5cdd22bbea7c7e13795df63a059c44c784b15'],
    ['system', ['1', '2026-03-17T13:18', '', 'system', 'Messages are end-to-end encrypted.', '', '0'], 'dc8af963c60e67efbcfca1e70edc825c38101116fbc04b3b8ca107f797b1bc49'],
    ['photo', ['1', '2026-04-03T15:17', 'Bo', 'photo', 'Mira \u00f1and\u00fa \u{1F9A4}', '00000091-PHOTO-2026-05-29-17-23-37.jpg', '0'], '640204f8b2cdf31f3720d8219a647198ab8f082eed3c441b0adf6565a1521764'],
  ])('%s', async (_name, fields, frozen) => {
    expect(await independentFingerprint(fields)).toBe(frozen);
  });

  test('and the module agrees with it on inputs that need normalizing', async () => {
    const input: FingerprintInput = { sentAt: '2026-05-06T07:08:09', author: '\u200e~ Mar\u00eda\u00a0Pau', type: 'text', text: 'hola\r\nque  tal \u200f', mediaName: '' };
    expect(fingerprintOf(input, 3)).toBe(await independentFingerprint(['1', '2026-05-06T07:08', 'Mar\u00eda Pau', 'text', 'hola\nque  tal', '', '3']));
  });
});

describe('documented limits (pinned: they are behaviour, not bugs to fix quietly)', () => {
  const ok: FingerprintInput = { sentAt: '2026-03-17T13:17:05', author: 'Bo', type: 'text', text: 'ok', mediaName: '' };
  const run = (n: number) => {
    const next = createFingerprinter();
    return Array.from({ length: n }, () => next(ok));
  };

  test('deleting one of several identical messages shifts the rest: a new identical message can look already stored', () => {
    const older = run(3); // ok, ok, ok
    const newer = run(3); // one was deleted and a new one sent in that minute: still three identical
    expect(newer).toEqual(older); // so the new one is skipped as a duplicate
    expect(run(2)).toEqual(older.slice(0, 2)); // fewer identical messages: nothing new, nothing lost
  });

  test('a message with other content between identical ones does not shift them', () => {
    const next = createFingerprinter();
    const first = next(ok);
    next({ ...ok, text: 'something else' });
    expect([first, next(ok)]).toEqual(run(2));
  });

  test('an export without media names no file: the attachment line becomes a different message', () => {
    const photo: FingerprintInput = { ...ok, author: 'Ana', type: 'photo', text: '', mediaName: 'IMG-1.jpg' };
    const omitted: FingerprintInput = { ...photo, type: 'omitted', text: '', mediaName: '' };
    expect(fingerprintOf(omitted, 0)).not.toBe(fingerprintOf(photo, 0));
  });

  test('a contact exported as a number and later as a saved name is a different author', () => {
    expect(fingerprintOf({ ...ok, author: '+34 600 11 22 33' }, 0)).not.toBe(fingerprintOf({ ...ok, author: 'Ana' }, 0));
  });

  test('the same message from a device in another time zone is a different minute', () => {
    expect(fingerprintOf({ ...ok, sentAt: '2026-03-17T14:17:05' }, 0)).not.toBe(fingerprintOf(ok, 0));
  });
});
