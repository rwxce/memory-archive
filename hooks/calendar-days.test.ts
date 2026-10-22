import { describe, expect, test } from 'vitest';
import { daysInMonth, daysOfMonth, leadingBlanks, monthOf, shiftMonth, summarizeYears, toDateString } from './calendar-days';

const day = (date: string, count: number, firstOffset = 0) => ({ date, count, firstOffset });

describe('summarizeYears', () => {
  test('adds up counts per year and month, ascending, only months with messages', () => {
    const years = summarizeYears([day('2025-01-02', 3), day('2024-12-31', 2), day('2024-03-05', 4), day('2024-03-06', 1), day('2025-01-30', 5)]);
    expect(years).toEqual([
      { year: 2024, count: 7, months: [{ month: 3, count: 5 }, { month: 12, count: 2 }] },
      { year: 2025, count: 8, months: [{ month: 1, count: 8 }] },
    ]);
  });

  test('is empty without days and skips malformed dates', () => {
    expect(summarizeYears([])).toEqual([]);
    expect(summarizeYears([day('nope', 1), day('2024-13-01', 1), day('2024-3-1', 1)])).toEqual([]);
  });
});

describe('month arithmetic (no timezone involved)', () => {
  test('days in a month, leap years included', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2025, 12)).toBe(31);
    expect(daysInMonth(2025, 4)).toBe(30);
  });

  test('blanks before the 1st in a Monday-first week', () => {
    expect(leadingBlanks(2024, 1)).toBe(0); // Mon 1 Jan 2024
    expect(leadingBlanks(2026, 3)).toBe(6); // Sun 1 Mar 2026
    expect(leadingBlanks(2025, 10)).toBe(2); // Wed 1 Oct 2025
  });

  test('shifts across year ends both ways', () => {
    expect(shiftMonth(2025, 12, 1)).toEqual({ year: 2026, month: 1 });
    expect(shiftMonth(2025, 1, -1)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth(2025, 6, 0)).toEqual({ year: 2025, month: 6 });
  });

  test('builds and reads date strings', () => {
    expect(toDateString(2026, 3, 7)).toBe('2026-03-07');
    expect(monthOf('2026-03-17T10:00:00')).toEqual({ year: 2026, month: 3 });
    expect(monthOf(null)).toBeNull();
    expect(monthOf('March')).toBeNull();
  });
});

describe('daysOfMonth', () => {
  test('keys the days of one month by day number', () => {
    const found = daysOfMonth([day('2026-03-17', 3), day('2026-04-01', 1), day('2026-03-02', 5)], 2026, 3);
    expect([...found.keys()]).toEqual([17, 2]);
    expect(found.get(2)?.count).toBe(5);
  });
});
