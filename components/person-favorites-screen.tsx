'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonFavoriteItem } from '@/components/person-favorite-item';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { ShowMore } from '@/components/show-more';
import { Shell } from '@/components/screen-shell';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonFavorites } from '@/hooks/use-person-favorites';
import type { PersonTimelineMessage } from '@/lib/domain/library';
import { MonthHeading } from './month-heading';
import { groupByMonth } from './group-by-month';

/**
 * A person's favorite messages: every message (or photo, voice note, file) marked with a star in any
 * conversation kept under them, oldest first, by month. The person is chosen by `?id=`. Rows come
 * 50 at a time with "Show more"; no file is read here, "Open in conversation" is the way to see it.
 * Removing a favorite takes it off the list at once and says so in a live region; there is no undo
 * because the message itself stays where it is and starring it again is one press in its conversation.
 */
export function PersonFavoritesScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonFavoritesContent onRetry={retry} />;
}

function PersonFavoritesContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personFavorites');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: favorites, loadMore, retry, remove } = usePersonFavorites(id);
  const [notice, setNotice] = useState<{ text: string; failed: boolean }>({ text: '', failed: false });

  const onRemove = async (item: PersonTimelineMessage) => {
    const result = await remove(item);
    if (result === 'removed') setNotice({ text: t('removed'), failed: false });
    else if (result === 'failed') setNotice({ text: t('removeFailed'), failed: true });
  };

  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });

  if (details.status === 'not-found' || favorites.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || favorites.status === 'error') {
    return (
      <Shell back={person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : retry}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (!person || favorites.status === 'loading') {
    return (
      <Shell>
        <LoadingNote>{t('loading')}</LoadingNote>
      </Shell>
    );
  }

  const { items, total, loadingMore, moreFailed } = favorites;
  const groups = groupByMonth(items);
  return (
    <Shell back={personBack}>
      <header className="flex items-end justify-between gap-3 px-1">
        <h1 className="font-display text-display">{t('title')}</h1>
        <p className="text-mu pb-1.5 text-end text-sm break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>
      <div className="min-h-5 text-sm break-words">
        <p role="status" className="text-mu">
          {notice.failed ? '' : notice.text}
        </p>
        <p role="alert" className="text-destructive">
          {notice.failed ? notice.text : ''}
        </p>
      </div>

      {total === 0 ? (
        <EmptyNote>
          {t('empty', { name: person.displayName })} {t('emptyHint')}
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.month} aria-labelledby={`month-${group.month}`} className="flex flex-col gap-2.5">
              <MonthHeading id={`month-${group.month}`} month={group.month} />
              <ul className="flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <PersonFavoriteItem key={`${item.conversationId}:${item.id}`} item={item} personId={person.id} onRemove={onRemove} />
                ))}
              </ul>
            </section>
          ))}
          <ShowMore
            shown={items.length}
            total={total}
            loading={loadingMore}
            failed={moreFailed}
            onMore={loadMore}
            labels={{ shown: t('shown', { shown: items.length, total }), moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
          />
        </div>
      )}
    </Shell>
  );
}
