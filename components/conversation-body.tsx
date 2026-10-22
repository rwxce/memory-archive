'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronsDown, ChevronsUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { savePosition } from '@/hooks/conversation-position';
import type { ConversationDay, ConversationMessage, PersonTimelineMessage } from '@/lib/domain/library';
import { useConversationDays } from '@/hooks/use-conversation-days';
import { useFavoriteToggle } from '@/hooks/use-favorite-toggle';
import { useMessagePages } from '@/hooks/use-message-pages';
import { useVirtualList, type ListStart } from '@/hooks/use-virtual-list';
import { ConversationCalendar } from './conversation-calendar';
import { formatDay } from './format';
import { MessageRow, PlaceholderRow } from './message-row';

const inputClass =
  'bg-background border-input h-11 min-w-0 rounded-md border px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]';

/**
 * What the feed shows, by position: one conversation, or a person's timeline across all of theirs.
 * The functions must be stable between renders (memoize them).
 */
export interface FeedSource {
  /** Identifies the feed: the saved reading position and the page cache are kept per key. */
  id: string;
  /** Accessible name of the feed. */
  label: string;
  count: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  start: ListStart;
  readWindow(offset: number, limit: number): Promise<ConversationMessage[]>;
  findOffset(date: string): Promise<number | null>;
  listDays(): Promise<ConversationDay[]>;
  /**
   * A person's timeline: rows carry their conversation (`PersonTimelineMessage`); the title is
   * shown above a message when it comes from another conversation than the previous one, linking
   * to that conversation on that day, coming back to `personId`. Without it, the conversation id
   * of the rows is `id`.
   */
  timeline?: { personId: string };
}

const isTimelineMessage = (message: ConversationMessage): message is PersonTimelineMessage => 'conversationId' in message;

/**
 * The jump controls and the virtualized feed. Only the rows near the view are in the DOM
 * (see `useVirtualList`); their messages come a page at a time (`useMessagePages`). Render it
 * with `key={source.id}`: a new feed starts with fresh state.
 */
export function ConversationBody({ source }: { source: FeedSource }) {
  const kind = source.timeline ? 'timeline' : 'conversation';
  const t = useTranslations('conversation');
  const tt = useTranslations('timeline');
  const locale = useLocale();
  const { id, count, start, findOffset, listDays } = source;
  const list = useVirtualList({ count, start });
  const pages = useMessagePages(id, count, source.readWindow);
  const [status, setStatus] = useState('');
  const toggleFavorite = useFavoriteToggle(id, pages.setFavorite, useCallback(() => setStatus(t('favorite.failed')), [t]));
  // Notes typed and not yet saved, by message: they outlive a row that scrolls out of the window.
  const noteDrafts = useRef(new Map<string, string>());
  const { setNote } = pages;
  const [day, setDay] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarButton = useRef<HTMLButtonElement>(null);
  const calendar = useConversationDays(listDays, calendarOpen);

  const { start: from, end: to } = list.range;
  const { request } = pages;
  useEffect(() => {
    request(from, to);
  }, [from, to, request]);

  // Where the person left off, for this tab only, so Back returns to the same place. It is noted
  // as the list scrolls (the list's element is already gone when the screen unmounts).
  const { position } = list;
  const left = useRef<ReturnType<typeof position>>(undefined);
  useEffect(() => {
    const save = () => savePosition(id, left.current);
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [id]);

  const jumpToken = useRef(0);
  const jump = async (value: string) => {
    setDay(value);
    const token = ++jumpToken.current;
    if (!value) return;
    try {
      const offset = await findOffset(value);
      // A newer pick (typing a year emits several dates) wins over a slower older lookup.
      if (token !== jumpToken.current) return;
      if (offset === null) {
        setStatus(t('noneAfter', { date: formatDay(value, locale) }));
        return;
      }
      list.scrollToIndex(offset);
      setStatus(t('jumped', { date: formatDay(value, locale) }));
    } catch {
      if (token === jumpToken.current) setStatus(t('pagesFailed'));
    }
  };

  const closeCalendar = () => {
    setCalendarOpen(false);
    calendarButton.current?.focus();
  };

  if (count === 0) {
    return <p className="bg-card text-muted-foreground m-4 rounded-xl border p-5 leading-relaxed break-words">{t('empty')}</p>;
  }

  const firstDay = source.firstSentAt?.slice(0, 10);
  const lastDay = source.lastSentAt?.slice(0, 10);
  const waiting = list.items.some((item) => !pages.at(item.index));

  return (
    <>
      <div role="group" aria-label={kind === 'timeline' ? tt('toolbarLabel') : t('toolbarLabel')} className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-2 sm:px-4">
        <Button variant="outline" onClick={list.scrollToStart}>
          <ChevronsUp aria-hidden />
          {t('toStart')}
        </Button>
        <Button variant="outline" onClick={list.scrollToEnd}>
          <ChevronsDown aria-hidden />
          {t('toEnd')}
        </Button>
        <Button
          ref={calendarButton}
          variant="outline"
          aria-expanded={calendarOpen}
          aria-controls={calendarOpen ? 'conversation-calendar' : undefined}
          onClick={() => (calendarOpen ? closeCalendar() : setCalendarOpen(true))}
        >
          <CalendarDays aria-hidden />
          {t('calendar.open')}
        </Button>
        <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
          <span>{t('date')}</span>
          <input type="date" className={inputClass} value={day} min={firstDay} max={lastDay} onChange={(event) => void jump(event.target.value)} />
        </label>
      </div>
      {calendarOpen && (
        <ConversationCalendar
          state={calendar.state}
          first={firstDay ?? null}
          last={lastDay ?? null}
          onPick={(date) => {
            void jump(date);
            closeCalendar();
          }}
          onClose={closeCalendar}
          onRetry={calendar.retry}
          label={kind === 'timeline' ? tt('calendarLabel') : undefined}
        />
      )}
      <div role="status" aria-live="polite" className="text-muted-foreground min-h-5 shrink-0 px-3 pb-1 text-sm break-words sm:px-4">
        {status}
      </div>
      {pages.failed && (
        <div role="alert" className="bg-card mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border p-3 text-sm sm:mx-4">
          <span className="min-w-0 flex-1">{t('pagesFailed')}</span>
          <Button variant="outline" onClick={pages.retry}>
            {t('retry')}
          </Button>
        </div>
      )}
      <div
        ref={list.scrollerRef}
        onScroll={(event) => {
          list.onScroll(event);
          left.current = position();
        }}
        role="feed"
        tabIndex={0}
        aria-label={source.label}
        aria-busy={waiting || pages.busy}
        data-testid="message-feed"
        className="focus-visible:ring-ring/50 relative min-h-0 flex-1 overflow-y-auto overscroll-contain border-t [overflow-anchor:none] focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        <div style={{ height: list.totalHeight }} className="relative w-full">
          {list.items.map(({ index, top }) => {
            const found = pages.at(index);
            if (!found) return <PlaceholderRow key={index} index={index} top={top} rowRef={list.rowRef} />;
            const { message, previous } = found;
            const own = isTimelineMessage(message) ? message : null;
            // On a timeline a message from another conversation than the one before names its own.
            const named = own && source.timeline && (!previous || !isTimelineMessage(previous) || previous.conversationId !== own.conversationId) ? own : null;
            return (
              <MessageRow
                key={index}
                conversationId={own?.conversationId ?? id}
                index={index}
                count={count}
                top={top}
                message={message}
                previous={previous}
                rowRef={list.rowRef}
                onToggleFavorite={toggleFavorite}
                noteDrafts={noteDrafts.current}
                onNoteChanged={setNote}
                conversationTitle={named?.conversationTitle}
                conversationHref={
                  named && source.timeline
                    ? `/conversation?id=${encodeURIComponent(named.conversationId)}&from=${encodeURIComponent(source.timeline.personId)}&date=${named.sentAt.slice(0, 10)}`
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
      {waiting && (
        <p role="status" className="sr-only">
          {t('loadingMessages')}
        </p>
      )}
    </>
  );
}
