'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { ConversationBody, type FeedSource } from '@/components/conversation-body';
import { LibraryNotice } from '@/components/library-notice';
import { BackPill } from '@/components/back-pill';
import { Eyebrow } from '@/components/eyebrow';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { FeedShell, Shell } from '@/components/screen-shell';
import { useLibrary, useLibraryDeps } from '@/hooks/use-library';
import { isDateParam, parseMessageParam } from '@/hooks/use-conversation';
import { timelinePositionKey, usePersonTimeline, type OpenTimeline } from '@/hooks/use-person-timeline';
import { findPersonTimelineOffsetByDate, findPersonTimelineOffsetById, getPersonTimelineWindow, listPersonTimelineDays } from '@/lib/usecases/person-timeline';
import { formatDateRange } from './format';

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
  return <PersonTimelineContent />;
}

function PersonTimelineContent() {
  const t = useTranslations('timeline');
  const tl = useTranslations('library');
  const tp = useTranslations('person');
  const locale = useLocale();
  const params = useSearchParams();
  const id = params.get('id');
  const date = params.get('date');
  const messageId = parseMessageParam(params.get('message'));
  const { state, retry } = usePersonTimeline(id, isDateParam(date) ? date : null);

  const peopleBack = usePeopleBack();
  const personBack = usePersonBack(state.status === 'ready' ? { id: state.timeline.person.id, displayName: state.timeline.person.name } : { id: id ?? '', displayName: '' });

  if (state.status === 'loading') {
    return (
      <Shell>
        <LoadingNote>{tl('loading')}</LoadingNote>
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell back={id ? { href: `/person?id=${encodeURIComponent(id)}`, label: tp('backToPerson') } : peopleBack}>
        <ErrorNote onRetry={retry}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (state.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }

  const { timeline } = state;
  const { person, bounds } = timeline;
  const dates = formatDateRange(bounds.firstSentAt, bounds.lastSentAt, locale);
  return (
    <FeedShell>
      <header className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2 sm:px-5">
        <BackPill href={personBack.href}>{personBack.label}</BackPill>
        <Eyebrow>{t('eyebrow')}</Eyebrow>
        <h1 className="font-display text-headline leading-tight break-words" dir="auto">
          {person.name}
        </h1>
        <p className="text-mu text-[13px]">
          {t('summary', { count: bounds.count, conversations: timeline.conversations })}
          {dates && ` · ${dates}`}
        </p>
      </header>
      {bounds.count === 0 ? (
        <div className="p-4">
          <EmptyNote>{t('empty', { name: person.name })}</EmptyNote>
        </div>
      ) : (
        <TimelineFeed key={person.id} timeline={timeline} messageId={messageId} />
      )}
    </FeedShell>
  );
}

/** The timeline's feed: the person's reads, handed to the shared body. */
function TimelineFeed({ timeline, messageId }: { timeline: OpenTimeline; messageId: number | null }) {
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
      findMessageOffset: (message) => findPersonTimelineOffsetById(deps, person.id, message),
      listDays: () => listPersonTimelineDays(deps, person.id),
      timeline: { personId: person.id },
    }),
    [deps, person.id, person.name, bounds, start, t],
  );
  return <ConversationBody source={source} messageId={messageId} />;
}
