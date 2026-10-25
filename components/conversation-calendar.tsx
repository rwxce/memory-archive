'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { daysOfMonth, monthOf, shiftMonth, summarizeYears, type CalendarYear } from '@/hooks/calendar-days';
import type { ConversationDaysState } from '@/hooks/use-conversation-days';
import type { ConversationDay } from '@/lib/domain/library';
import { CalendarDayGrid } from './calendar-day-grid';

type Level = { kind: 'years' } | { kind: 'months'; year: number } | { kind: 'days'; year: number; month: number };

const choiceBase =
  'focus-visible:ring-ring/50 flex min-h-11 flex-col items-center justify-center rounded-xl px-2 py-1 outline-none focus-visible:ring-[3px] motion-safe:transition-colors sm:flex-row sm:gap-1.5';
/** A year or month with messages: a chip, in the accent when it holds the day being read. */
const choiceClass = (current: boolean) =>
  cn(choiceBase, 'hover:bg-ac-soft hover:text-ac-tx', current ? 'bg-ac-soft text-ac-tx font-semibold' : 'bg-sf2 text-foreground');
/** A month without messages: plain muted text, not a button-looking box. */
const emptyChoiceClass = cn(choiceBase, 'text-mu pointer-events-none opacity-60');

const monthName = (locale: string, year: number, month: number, style: 'long' | 'short') =>
  new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));

/**
 * The calendar of a conversation: years, then the months of a year, then a grid of days. Choosing
 * a day calls `onPick` with `YYYY-MM-DD`; Escape and the close button call `onClose`. The days come
 * from the parent (read lazily, see `useConversationDays`); `first` and `last` are the days of the
 * first and last message and limit the month arrows.
 */
export function ConversationCalendar({
  state,
  first,
  last,
  current,
  onPick,
  onClose,
  onRetry,
  label,
  footer,
}: {
  state: ConversationDaysState;
  first: string | null;
  last: string | null;
  /** `YYYY-MM-DD` of the day being read, marked in the year and month lists. */
  current?: string | null;
  onPick: (date: string) => void;
  onClose: () => void;
  onRetry: () => void;
  /** Accessible name of the panel; defaults to the conversation's. */
  label?: string;
  /** Extra controls under the calendar (the plain date field). */
  footer?: ReactNode;
}) {
  const t = useTranslations('conversation');
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <section
      id="conversation-calendar"
      aria-label={label ?? t('calendar.panelLabel')}
      onKeyDown={onKeyDown}
      className="bg-bg border-glass-line shadow-soft absolute inset-x-4 bottom-2 z-20 mx-auto flex max-h-[calc(100%-1rem)] flex-col gap-2 overflow-y-auto rounded-3xl border p-3 sm:max-w-xl"
    >
      {state.status === 'ready' && state.days.length > 0 ? (
        <Browser days={state.days} first={first} last={last} current={current ?? null} onPick={onPick} onClose={onClose} />
      ) : (
        <Frame level={state.status} title={t('calendar.title')} onClose={onClose}>
          {state.status === 'error' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <span className="min-w-0 flex-1">{t('calendar.failed')}</span>
              <Button variant="outline" onClick={onRetry}>
                {t('retry')}
              </Button>
            </div>
          ) : state.status === 'ready' ? (
            <p className="text-mu text-sm">{t('calendar.none')}</p>
          ) : (
            <p role="status" className="text-mu text-sm">
              {t('calendar.loading')}
            </p>
          )}
        </Frame>
      )}
      {footer}
    </section>
  );
}

/** Title row with the close button, and the focusable heading that gets focus when the level changes. */
function Frame({ title, level, onClose, children, before, actions }: { title: string; level: string; onClose: () => void; children: ReactNode; before?: ReactNode; actions?: ReactNode }) {
  const t = useTranslations('conversation');
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus follows the step (years, months, days), not the month arrows, which keep their focus.
  useEffect(() => heading.current?.focus(), [level]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {before}
          <h2 ref={heading} tabIndex={-1} aria-live="polite" className="font-display text-xl leading-tight break-words outline-none">
            {title}
          </h2>
        </div>
        {actions}
        <Button variant="ghost" size="icon" aria-label={t('calendar.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  );
}

function Browser({
  days,
  first,
  last,
  current,
  onPick,
  onClose,
}: {
  days: ConversationDay[];
  first: string | null;
  last: string | null;
  current: string | null;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('conversation');
  const locale = useLocale();
  const years = summarizeYears(days);
  const count = new Intl.NumberFormat(locale);
  // One year only: the years step would be a single button, so start at its months.
  const [level, setLevel] = useState<Level>(() => (years.length === 1 ? { kind: 'months', year: years[0].year } : { kind: 'years' }));
  const currentMonth = monthOf(current);
  const messages = (n: number) => t('messageCount', { count: n });

  const back = (label: string, to: Level) => (
    <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => setLevel(to)}>
      <ArrowLeft aria-hidden />
      {label}
    </Button>
  );

  if (level.kind === 'years') {
    return (
      <Frame level="years" title={t('calendar.chooseYear')} onClose={onClose}>
        <ul className="grid grid-cols-4 gap-1.5">
          {years.map(({ year, count: n }) => (
            <li key={year} className="contents">
              <button type="button" className={choiceClass(currentMonth?.year === year)} aria-current={currentMonth?.year === year || undefined} aria-label={t('calendar.yearLabel', { year, messages: messages(n) })} onClick={() => setLevel({ kind: 'months', year })}>
                <span aria-hidden className="text-base font-medium">{year}</span>
                <span aria-hidden className="text-mu text-xs font-normal">{count.format(n)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Frame>
    );
  }

  if (level.kind === 'months') {
    const year = years.find((y) => y.year === level.year) as CalendarYear;
    const withMessages = new Map(year.months.map((m) => [m.month, m.count]));
    return (
      <Frame
        level="months"
        title={t('calendar.chooseMonth', { year: level.year })}
        onClose={onClose}
        before={years.length > 1 ? back(t('calendar.allYears'), { kind: 'years' }) : undefined}
      >
        <ul className="grid grid-cols-4 gap-1.5">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
            const n = withMessages.get(month);
            const long = monthName(locale, level.year, month, 'long');
            return (
              <li key={month} className="contents">
                <button
                  type="button"
                  className={n === undefined ? emptyChoiceClass : choiceClass(currentMonth?.year === level.year && currentMonth.month === month)}
                  aria-current={(n !== undefined && currentMonth?.year === level.year && currentMonth.month === month) || undefined}
                  disabled={n === undefined}
                  aria-label={n === undefined ? t('calendar.monthEmpty', { month: long }) : t('calendar.monthLabel', { month: long, messages: messages(n) })}
                  onClick={() => setLevel({ kind: 'days', year: level.year, month })}
                >
                  <span aria-hidden className="text-sm font-medium capitalize">{monthName(locale, level.year, month, 'short')}</span>
                  {n !== undefined && (
                    <span aria-hidden className="text-mu text-xs font-normal">{count.format(n)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Frame>
    );
  }

  const { year, month } = level;
  const firstMonth = monthOf(first) ?? { year: years[0].year, month: years[0].months[0].month };
  const lastYear = years[years.length - 1];
  const lastMonth = monthOf(last) ?? { year: lastYear.year, month: lastYear.months[lastYear.months.length - 1].month };
  const index = (m: { year: number; month: number }) => m.year * 12 + m.month;
  const step = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    if (index(next) >= index(firstMonth) && index(next) <= index(lastMonth)) setLevel({ kind: 'days', ...next });
  };
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  const atFirst = index({ year, month }) <= index(firstMonth);
  const atLast = index({ year, month }) >= index(lastMonth);
  const arrow = (label: string, delta: number, off: boolean, icon: ReactNode) => (
    <Button variant="outline" size="icon" aria-label={label} aria-disabled={off || undefined} className={cn(off && 'opacity-50')} onClick={() => step(delta)}>
      {icon}
    </Button>
  );

  return (
    <Frame
      level="days"
      title={title}
      onClose={onClose}
      before={back(t('calendar.monthsOf', { year }), { kind: 'months', year })}
      actions={
        <>
          {arrow(t('calendar.previousMonth'), -1, atFirst, <ChevronLeft aria-hidden />)}
          {arrow(t('calendar.nextMonth'), 1, atLast, <ChevronRight aria-hidden />)}
        </>
      }
    >
      <CalendarDayGrid key={`${year}-${month}`} year={year} month={month} byDay={daysOfMonth(days, year, month)} label={title} onPick={onPick} />
    </Frame>
  );
}
