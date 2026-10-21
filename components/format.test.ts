import { describe, expect, test } from 'vitest';
import { formatBytes, formatDateRange, formatNames, initialsOf } from './format';

describe('formatBytes', () => {
  test('decimal units, one decimal below 10, localized separators', () => {
    expect(formatBytes(0, 'en')).toBe('0 byte');
    expect(formatBytes(1_234_567, 'en')).toBe('1.2 MB');
    expect(formatBytes(45_000_000_000, 'en')).toBe('45 GB');
    expect(formatBytes(1_234_567, 'ca')).toMatch(/^1,2\sMB$/);
  });
});

describe('initialsOf', () => {
  test('first letters of the first and last word, upper-cased', () => {
    expect(initialsOf('Ana')).toBe('A');
    expect(initialsOf('  ana maria puig ')).toBe('AP');
    expect(initialsOf('émile zola')).toBe('ÉZ');
  });

  test('never cuts a character in half and never returns an empty string', () => {
    expect(initialsOf('🌻 Sunflower')).toBe('🌻S');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});

describe('formatDateRange', () => {
  test('one day, a span, or nothing; wall-clock dates are never shifted by a timezone', () => {
    expect(formatDateRange('2024-03-12T00:05:00', '2024-03-12T23:59:00', 'en')).toBe('Mar 12, 2024');
    expect(formatDateRange('2024-03-12T09:00:00', '2025-07-03T10:00:00', 'en')).toBe('Mar 12, 2024 – Jul 3, 2025');
    expect(formatDateRange(null, null, 'en')).toBe('');
  });
});

describe('formatNames', () => {
  test('joins names the way the language does', () => {
    expect(formatNames(['Ana', 'Bo', 'Cy'], 'en')).toBe('Ana, Bo, and Cy');
    expect(formatNames(['Ana', 'Bo'], 'es')).toBe('Ana y Bo');
    expect(formatNames(['Ana', 'Bo', 'Cy'], 'en', true)).toBe('Ana, Bo, Cy');
  });
});
