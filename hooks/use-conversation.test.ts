import { describe, expect, test } from 'vitest';
import { isDateParam, parseMessageParam } from './use-conversation';

describe('isDateParam', () => {
  test('accepts a real calendar day', () => {
    expect(isDateParam('2026-02-28')).toBe(true);
    expect(isDateParam('2024-02-29')).toBe(true);
  });

  test('rejects days that do not exist (they would reach the database as `invalid`)', () => {
    expect(isDateParam('2026-02-30')).toBe(false);
    expect(isDateParam('2023-02-31')).toBe(false);
    expect(isDateParam('2026-13-01')).toBe(false);
    expect(isDateParam('2025-02-29')).toBe(false);
  });

  test('rejects missing and malformed values', () => {
    expect(isDateParam(null)).toBe(false);
    expect(isDateParam('')).toBe(false);
    expect(isDateParam('2026-2-3')).toBe(false);
    expect(isDateParam('not-a-date')).toBe(false);
  });
});

describe('parseMessageParam', () => {
  test('accepts a positive integer id', () => {
    expect(parseMessageParam('1')).toBe(1);
    expect(parseMessageParam('48213')).toBe(48213);
  });

  test('ignores anything else', () => {
    for (const bad of [null, '', '0', '-3', '01', '1.5', '1e3', ' 7', '7 ', 'abc', '12abc', '9'.repeat(16), '<img>']) expect(parseMessageParam(bad)).toBeNull();
  });
});
