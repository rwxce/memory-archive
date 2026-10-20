import { describe, expect, test } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  test('decimal units, one decimal below 10, localized separators', () => {
    expect(formatBytes(0, 'en')).toBe('0 byte');
    expect(formatBytes(1_234_567, 'en')).toBe('1.2 MB');
    expect(formatBytes(45_000_000_000, 'en')).toBe('45 GB');
    expect(formatBytes(1_234_567, 'ca')).toMatch(/^1,2\sMB$/);
  });
});
