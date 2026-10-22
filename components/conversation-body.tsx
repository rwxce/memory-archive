'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronsDown, ChevronsUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { savePosition } from '@/hooks/conversation-position';
import type { OpenConversation } from '@/hooks/use-conversation';
import { useMessagePages } from '@/hooks/use-message-pages';
import { useVirtualList } from '@/hooks/use-virtual-list';
import { formatDay } from './format';
import { MessageRow, PlaceholderRow } from './message-row';

const inputClass =
  'bg-background border-input h-11 min-w-0 rounded-md border px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]';

/**
 * The jump controls and the virtualized feed. Only the rows near the view are in the DOM
 * (see `useVirtualList`); their messages come a page at a time (`useMessagePages`). Render it
 * with `key={conversation id}`: a new conversation starts with fresh state.
 */
export function ConversationBody({
  conversation,
  findOffset,
}: {
  conversation: OpenConversation;
  findOffset: (date: string) => Promise<number | null>;
}) {
  const t = useTranslations('conversation');
  const locale = useLocale();
  const { view, start } = conversation;
  const id = view.conversation.id;
  const count = view.bounds.count;
  const list = useVirtualList({ count, start });
  const pages = useMessagePages(id, count);
  const [status, setStatus] = useState('');
  const [day, setDay] = useState('');

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

  if (count === 0) {
    return <p className="bg-card text-muted-foreground m-4 rounded-xl border p-5 leading-relaxed break-words">{t('empty')}</p>;
  }

  const firstDay = view.bounds.firstSentAt?.slice(0, 10);
  const lastDay = view.bounds.lastSentAt?.slice(0, 10);
  const waiting = list.items.some((item) => !pages.at(item.index));

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

  return (
    <>
      <div role="group" aria-label={t('toolbarLabel')} className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-2 sm:px-4">
        <Button variant="outline" onClick={list.scrollToStart}>
          <ChevronsUp aria-hidden />
          {t('toStart')}
        </Button>
        <Button variant="outline" onClick={list.scrollToEnd}>
          <ChevronsDown aria-hidden />
          {t('toEnd')}
        </Button>
        <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
          <span>{t('date')}</span>
          <input type="date" className={inputClass} value={day} min={firstDay} max={lastDay} onChange={(event) => void jump(event.target.value)} />
        </label>
      </div>
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
        aria-label={t('feedLabel', { title: view.conversation.title })}
        aria-busy={waiting || pages.busy}
        data-testid="message-feed"
        className="focus-visible:ring-ring/50 relative min-h-0 flex-1 overflow-y-auto overscroll-contain border-t [overflow-anchor:none] focus-visible:ring-[3px] focus-visible:ring-inset"
      >
        <div style={{ height: list.totalHeight }} className="relative w-full">
          {list.items.map(({ index, top }) => {
            const found = pages.at(index);
            return found ? (
              <MessageRow key={index} index={index} count={count} top={top} message={found.message} previous={found.previous} rowRef={list.rowRef} />
            ) : (
              <PlaceholderRow key={index} index={index} top={top} rowRef={list.rowRef} />
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
