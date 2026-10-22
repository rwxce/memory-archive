import { describe, expect, test } from 'vitest';
import { formatClock } from './clock';

describe('formatClock', () => {
  test.each([
    [0, '0:00'],
    [17.9, '0:17'],
    [605, '10:05'],
    [3729, '1:02:09'],
    [Number.NaN, '0:00'],
    [Number.POSITIVE_INFINITY, '0:00'],
    [-4, '0:00'],
  ])('%s -> %s', (input, out) => {
    expect(formatClock(input)).toBe(out);
  });
});
