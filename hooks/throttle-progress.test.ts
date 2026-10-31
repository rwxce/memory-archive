import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { throttleProgress, type PackProgress } from './throttle-progress';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('throttleProgress', () => {
  test('a walk over many files reaches the screen a few times, never missing a new phase or the last file', () => {
    const seen: PackProgress[] = [];
    const deliver = throttleProgress((p) => seen.push(p));
    deliver({ phase: 'preparing' });
    for (let done = 0; done <= 5000; done++) deliver({ phase: 'media', done, total: 5000 });
    deliver({ phase: 'finishing' });
    // The first of each phase, a whole percent at a time at most, and the last file.
    expect(seen.length).toBeLessThanOrEqual(104);
    expect(seen[0]).toEqual({ phase: 'preparing' });
    expect(seen.at(-1)).toEqual({ phase: 'finishing' });
    expect(seen).toContainEqual({ phase: 'media', done: 5000, total: 5000 });
  });

  test('updates that come quickly and stay within the same percent are dropped, a later one is not', () => {
    const seen: PackProgress[] = [];
    const deliver = throttleProgress((p) => seen.push(p));
    deliver({ phase: 'media', done: 1, total: 1000 });
    deliver({ phase: 'media', done: 2, total: 1000 });
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(150);
    deliver({ phase: 'media', done: 3, total: 1000 });
    expect(seen).toHaveLength(2);
  });
});
