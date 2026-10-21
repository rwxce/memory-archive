import { describe, expect, test } from 'vitest';
import { HeightIndex } from './height-index';

describe('HeightIndex', () => {
  test('with nothing measured every row is the estimate', () => {
    const h = new HeightIndex(1000, 60);
    expect(h.total()).toBe(60_000);
    expect(h.offsetOf(0)).toBe(0);
    expect(h.offsetOf(10)).toBe(600);
    expect(h.indexAt(0)).toBe(0);
    expect(h.indexAt(599)).toBe(9);
    expect(h.indexAt(600)).toBe(10);
    expect(h.indexAt(-50)).toBe(0);
    expect(h.indexAt(10_000_000)).toBe(999);
  });

  test('a measurement moves only the rows after it, and reports the change', () => {
    const h = new HeightIndex(100, 50);
    expect(h.measure(3, 80)).toBe(30);
    expect(h.offsetOf(3)).toBe(150);
    expect(h.offsetOf(4)).toBe(230);
    expect(h.total()).toBe(5030);
    expect(h.measure(3, 80)).toBe(0);
    expect(h.measure(3, 40)).toBe(-40);
    expect(h.total()).toBe(4990);
    expect(h.isMeasured(3)).toBe(true);
    expect(h.isMeasured(4)).toBe(false);
    expect(h.heightOf(4)).toBe(50);
  });

  test('matches a plain running sum for random measurements, offsets and lookups', () => {
    const n = 500;
    const h = new HeightIndex(n, 64);
    const heights = Array.from({ length: n }, () => 64);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let k = 0; k < 800; k++) {
      const i = Math.floor(rand() * n);
      const height = 20 + Math.floor(rand() * 300);
      h.measure(i, height);
      heights[i] = height;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      expect(h.offsetOf(i)).toBeCloseTo(sum, 3);
      expect(h.indexAt(sum + heights[i] / 2)).toBe(i);
      sum += heights[i];
    }
    expect(h.total()).toBeCloseTo(sum, 3);
  });

  test('rangeFor covers the viewport plus overscan and is bounded by max', () => {
    const h = new HeightIndex(200_000, 64);
    const middle = h.offsetOf(100_000);
    const { start, end } = h.rangeFor(middle, 800, 400);
    expect(h.offsetOf(start)).toBeLessThanOrEqual(middle - 400);
    expect(h.offsetOf(end)).toBeGreaterThanOrEqual(middle + 800 + 400);
    expect(end - start).toBeLessThan(40);
    expect(h.rangeFor(0, 10_000_000, 0, 50)).toEqual({ start: 0, end: 50 });
    expect(h.rangeFor(h.total(), 800, 400).end).toBe(200_000);
  });

  test('empty list and bad input', () => {
    const h = new HeightIndex(0, 64);
    expect(h.total()).toBe(0);
    expect(h.indexAt(10)).toBe(-1);
    expect(h.rangeFor(0, 800, 400)).toEqual({ start: 0, end: 0 });
    expect(() => new HeightIndex(-1, 64)).toThrow();
    expect(() => new HeightIndex(1, 0)).toThrow();
    const one = new HeightIndex(1, 10);
    expect(one.measure(5, 10)).toBe(0);
    expect(one.measure(0, 0)).toBe(0);
    expect(one.measure(0, NaN)).toBe(0);
  });

  test('200,000 rows: building and 10,000 measure+lookups take milliseconds', () => {
    const t0 = performance.now();
    const h = new HeightIndex(200_000, 64);
    for (let k = 0; k < 10_000; k++) {
      h.measure((k * 7919) % 200_000, 40 + (k % 90));
      h.indexAt(h.total() / 2);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
