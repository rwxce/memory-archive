import type { ConversationDay } from '@/lib/domain/library';

/**
 * Pure helpers for the conversation calendar. Dates are the `YYYY-MM-DD` strings the database
 * returns (the local day written in the chat, no timezone). `Date.UTC` appears only to ask the
 * calendar how long a month is and which weekday the 1st falls on; it is never read back as a
 * moment, so nothing shifts with the viewer's timezone.
 *
 * Weeks start on Monday in every locale we ship (ca, es, en). Revisit if a locale with another
 * convention is added.
 */

export interface CalendarMonth {
  /** 1-12. */
  month: number;
  count: number;
}

export interface CalendarYear {
  year: number;
  count: number;
  /** Only the months that have messages, ascending. */
  months: CalendarMonth[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Years (ascending) with their message counts and the months that have messages. Malformed dates are skipped. */
export function summarizeYears(days: readonly ConversationDay[]): CalendarYear[] {
  const years = new Map<number, Map<number, number>>();
  for (const { date, count } of days) {
    const match = DAY.exec(date);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    const months = years.get(year) ?? new Map<number, number>();
    months.set(month, (months.get(month) ?? 0) + count);
    years.set(year, months);
  }
  return [...years.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, months]) => {
      const list = [...months.entries()].sort(([a], [b]) => a - b).map(([month, count]) => ({ month, count }));
      return { year, count: list.reduce((sum, m) => sum + m.count, 0), months: list };
    });
}

/** The days of one month that have messages, by day of month (1-31). */
export function daysOfMonth(days: readonly ConversationDay[], year: number, month: number): Map<number, ConversationDay> {
  const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
  const found = new Map<number, ConversationDay>();
  for (const day of days) if (day.date.startsWith(prefix) && DAY.test(day.date)) found.set(Number(day.date.slice(8)), day);
  return found;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Empty cells before the 1st in a Monday-first week (0 when the month starts on a Monday). */
export function leadingBlanks(year: number, month: number): number {
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}

export function toDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Month `delta` months away from `year`-`month`. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Year and month of a `YYYY-MM-DD...` stamp, or `null` when it is not one. */
export function monthOf(stamp: string | null | undefined): { year: number; month: number } | null {
  const match = stamp ? DAY.exec(stamp.slice(0, 10)) : null;
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}
