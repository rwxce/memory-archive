'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/components/ui/utils';
import type { ConversationDay } from '@/lib/domain/library';
import { daysInMonth, leadingBlanks, toDateString } from '@/hooks/calendar-days';
import { formatFullDay } from './format';

/** Monday-first weekday names (2024-01-01 was a Monday), long for screen readers and short to show. */
function weekdays(locale: string): Array<{ long: string; short: string }> {
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.UTC(2024, 0, 1 + i));
    return { long: long.format(date), short: short.format(date) };
  });
}

/**
 * One month as a grid of days. Every day can be reached with the arrow keys (one tab stop for the
 * whole grid), but only days that have messages can be chosen; the others say so and do nothing.
 */
export function CalendarDayGrid({
  year,
  month,
  byDay,
  label,
  onPick,
}: {
  year: number;
  month: number;
  byDay: Map<number, ConversationDay>;
  label: string;
  onPick: (date: string) => void;
}) {
  const t = useTranslations('conversation');
  const locale = useLocale();
  const length = daysInMonth(year, month);
  const blanks = leadingBlanks(year, month);
  const first = Math.min(...byDay.keys(), length);
  const [focus, setFocus] = useState(first);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const compact = new Intl.NumberFormat(locale, { notation: 'compact' });

  const cells: Array<number | null> = [...Array<null>(blanks).fill(null), ...Array.from({ length }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, r) => cells.slice(r * 7, r * 7 + 7));

  const move = (event: KeyboardEvent) => {
    const column = (blanks + focus - 1) % 7;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -column, End: 6 - column };
    if (!Object.hasOwn(step, event.key)) return;
    event.preventDefault();
    const target = Math.min(length, Math.max(1, focus + step[event.key]));
    setFocus(target);
    buttons.current.get(target)?.focus();
  };

  return (
    <table role="grid" aria-label={label} onKeyDown={move} className="w-full table-fixed border-separate border-spacing-0.5">
      <thead>
        <tr>
          {weekdays(locale).map((day) => (
            <th key={day.long} scope="col" abbr={day.long} className="text-mu pb-0.5 text-xs font-normal">
              <span aria-hidden>{day.short}</span>
              <span className="sr-only">{day.long}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((day, c) => {
              if (day === null) return <td key={c} />;
              const entry = byDay.get(day);
              const date = toDateString(year, month, day);
              const when = formatFullDay(date, locale);
              return (
                <td key={c} role="gridcell" className="p-0">
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) buttons.current.set(day, el);
                      else buttons.current.delete(day);
                    }}
                    tabIndex={day === focus ? 0 : -1}
                    aria-disabled={entry ? undefined : true}
                    aria-label={entry ? t('calendar.dayLabel', { date: when, messages: t('messageCount', { count: entry.count }) }) : t('calendar.dayEmpty', { date: when })}
                    onFocus={() => setFocus(day)}
                    onClick={() => entry && onPick(date)}
                    className={cn(
                      'focus-visible:ring-ring/50 flex min-h-11 w-full flex-col items-center justify-center rounded-xl text-sm outline-none focus-visible:ring-[3px] motion-safe:transition-colors',
                      entry ? 'bg-sf2 text-foreground hover:bg-ac-soft hover:text-ac-tx font-medium' : 'text-mu aria-disabled:cursor-default opacity-60',
                    )}
                  >
                    <span aria-hidden>{day}</span>
                    {entry && (
                      <span aria-hidden className="text-mu text-[10px] leading-none">
                        {compact.format(entry.count)}
                      </span>
                    )}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
