import { describe, expect, test } from 'vitest';
import { findRanges, fold, queryTerms, snippet, splitLinks } from './text';

describe('fold', () => {
  test('lower-cases and strips accents', () => {
    expect(fold('Ça Va, ÀNIMA')).toBe('ca va, anima');
    expect(fold('plain ASCII')).toBe('plain ascii');
  });
  test('terms split on whitespace', () => {
    expect(queryTerms('  Hola   MÓN ')).toEqual(['hola', 'mon']);
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('findRanges', () => {
  test('finds accent-insensitive matches with original offsets', () => {
    const text = 'Camí al Pirineu, camí llarg';
    expect(findRanges(text, ['cami']).map((r) => text.slice(r.start, r.end))).toEqual(['Camí', 'camí']);
  });
  test('merges overlapping terms and survives surrogate pairs', () => {
    const text = 'a 😀 abc';
    const r = findRanges(text, ['ab', 'bc']);
    expect(r).toHaveLength(1);
    expect(text.slice(r[0].start, r[0].end)).toBe('abc');
    expect(findRanges('😀 x', ['x'])).toEqual([{ start: 3, end: 4 }]);
  });
  test('nothing for empty input', () => {
    expect(findRanges('', ['a'])).toEqual([]);
    expect(findRanges('abc', [])).toEqual([]);
  });
});

describe('splitLinks', () => {
  test('parts cover the text and only http(s) become links', () => {
    const text = 'see https://example.com/a. and javascript:alert(1) or http://x.org/b)';
    const parts = splitLinks(text);
    expect(parts.map((p) => text.slice(p.start, p.end)).join('')).toBe(text);
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual(['https://example.com/a', 'http://x.org/b)']);
  });
});

describe('snippet', () => {
  test('cuts around the first match and shifts the ranges', () => {
    const text = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
    const s = snippet(text, findRanges(text, ['needle']));
    expect(s.text.length).toBeLessThan(200);
    expect(s.text.slice(s.ranges[0].start, s.ranges[0].end)).toBe('needle');
  });
  test('collapses whitespace and keeps ranges aligned', () => {
    const text = 'one\n\n  two needle';
    const s = snippet(text, findRanges(text, ['needle']));
    expect(s.text).toBe('one two needle');
    expect(s.text.slice(s.ranges[0].start, s.ranges[0].end)).toBe('needle');
  });
});
