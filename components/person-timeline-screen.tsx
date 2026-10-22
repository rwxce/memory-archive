'use client';

import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { ConversationBody, type FeedSource } from '@/components/conversation-body';
import { LibraryNotice } from '@/components/library-notice';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useLibrary, useLibraryDeps } from '@/hooks/use-library';
import { isDateParam } from '@/hooks/use-conversation';
import { timelinePositionKey, usePersonTimeline, type OpenTimeline } from '@/hooks/use-person-timeline';
import { Link } from '@/i18n/navigation';
import { findPersonTimelineOffsetByDate, getPersonTimelineWindow, listPersonTimelineDays } from '@/lib/usecases/person-timeline';
import { formatDateRange } from './format';

const backLinkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

/**
 * A person's whole history as one feed: the messages of every conversation kept under them, oldest
 * first, looking like a conversation (same rows, same jump controls, same calendar) with a small
 * title above a message that comes from another conversation than the one before. The person is
 * chosen by `?id=`; `?date=YYYY-MM-DD` opens at that day.
 */
export function PersonTimelineScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonTimelineContent onRetry={retry} />;
}

function PersonTimelineContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('timeline');
  const tl = useTranslations('library');
  const tp = useTranslations('person');
  const locale = useLocale();
  const params = useSearchParams();
  const id = params.get('id');
  const date = params.get('date');
  const { state, retry } = usePersonTimeline(id, isDateParam(date) ? date : null);

  if (state.status === 'loading') {
    return (
      <Shell>
        <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell>
        <Link href={id ? `/person?id=${encodeURIComponent(id)}` : '/people'} className={backLinkClass}>
          <ArrowLeft className="size-4" aria-hidden />
          {id ? tp('backToPerson') : tp('back')}
        </Link>
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={retry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }
  if (state.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{tp('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{tp('notFoundBody')}</p>
          <Link href="/people" className={backLinkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {tp('back')}
          </Link>
        </section>
      </Shell>
    );
  }

  const { timeline } = state;
  const { person, bounds } = timeline;
  const dates = formatDateRange(bounds.firstSentAt, bounds.lastSentAt, locale);
  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex shrink-0 flex-col gap-1 px-3 pt-2 pb-2 sm:px-4">
        <Link href={`/person?id=${encodeURIComponent(person.id)}`} className={backLinkClass}>
          <ArrowLeft className="size-4" aria-hidden />
          {t('back', { name: person.name })}
        </Link>
        <p className="text-muted-foreground text-sm">{t('eyebrow')}</p>
        <h1 className="font-serif text-2xl leading-tight break-words">{person.name}</h1>
        <p className="text-muted-foreground text-sm">
          {t('summary', { count: bounds.count, conversations: timeline.conversations })}
          {dates && ` · ${dates}`}
        </p>
      </header>
      {bounds.count === 0 ? (
        <p className="bg-card text-muted-foreground m-4 rounded-xl border p-5 leading-relaxed break-words">{t('empty', { name: person.name })}</p>
      ) : (
        <TimelineFeed key={person.id} timeline={timeline} />
      )}
    </div>
  );
}

/** The timeline's feed: the person's reads, handed to the shared body. */
function TimelineFeed({ timeline }: { timeline: OpenTimeline }) {
  const t = useTranslations('timeline');
  const deps = useLibraryDeps()!;
  const { person, bounds, start } = timeline;
  const source = useMemo<FeedSource>(
    () => ({
      id: timelinePositionKey(person.id),
      label: t('feedLabel', { name: person.name }),
      count: bounds.count,
      firstSentAt: bounds.firstSentAt,
      lastSentAt: bounds.lastSentAt,
      start,
      readWindow: (offset, limit) => getPersonTimelineWindow(deps, person.id, offset, limit),
      findOffset: (day) => findPersonTimelineOffsetByDate(deps, person.id, day),
      listDays: () => listPersonTimelineDays(deps, person.id),
      timeline: { personId: person.id },
    }),
    [deps, person.id, person.name, bounds, start, t],
  );
  return <ConversationBody source={source} />;
}
