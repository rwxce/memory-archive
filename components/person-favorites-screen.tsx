'use client';

import { useState } from 'react';
import { ArrowLeft, Loader } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonFavoriteItem } from '@/components/person-favorite-item';
import { PersonSections } from '@/components/person-sections';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonFavorites } from '@/hooks/use-person-favorites';
import { Link } from '@/i18n/navigation';
import type { PersonTimelineMessage } from '@/lib/domain/library';
import { formatMonth } from './format';
import { groupByMonth } from './group-by-month';

const linkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

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
  const tp = useTranslations('person');
  const tl = useTranslations('library');
  const locale = useLocale();
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: favorites, loadMore, retry, remove } = usePersonFavorites(id);
  const [notice, setNotice] = useState<{ text: string; failed: boolean }>({ text: '', failed: false });

  const onRemove = async (item: PersonTimelineMessage) => {
    const result = await remove(item);
    if (result === 'removed') setNotice({ text: t('removed'), failed: false });
    else if (result === 'failed') setNotice({ text: t('removeFailed'), failed: true });
  };

  if (details.status === 'not-found' || favorites.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{tp('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{tp('notFoundBody')}</p>
          <Link href="/people" className={linkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {tp('back')}
          </Link>
        </section>
      </Shell>
    );
  }
  if (details.status === 'error' || favorites.status === 'error') {
    return (
      <Shell>
        <Link href={id ? `/person?id=${encodeURIComponent(id)}` : '/people'} className={linkClass}>
          <ArrowLeft className="size-4" aria-hidden />
          {id ? tp('backToPerson') : tp('back')}
        </Link>
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={details.status === 'error' ? onRetry : retry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }
  if (details.status === 'loading' || favorites.status === 'loading') {
    return (
      <Shell>
        <p role="status" className="text-muted-foreground flex items-center gap-2 py-6">
          <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('loading')}
        </p>
      </Shell>
    );
  }

  const person = details.details.person;
  const { items, total, loadingMore, moreFailed } = favorites;
  const groups = groupByMonth(items);
  return (
    <Shell>
      <Link href={`/person?id=${encodeURIComponent(person.id)}`} className={linkClass}>
        <ArrowLeft className="size-4" aria-hidden />
        {t('back', { name: person.displayName })}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl break-words">{t('title')}</h1>
        <p className="text-muted-foreground break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>
      <PersonSections personId={person.id} current="favorites" />
      <div className="min-h-5 text-sm break-words">
        <p role="status" className="text-muted-foreground">
          {notice.failed ? '' : notice.text}
        </p>
        <p role="alert" className="text-destructive">
          {notice.failed ? notice.text : ''}
        </p>
      </div>

      {total === 0 ? (
        <section className="bg-card flex flex-col gap-2 rounded-xl border p-5 leading-relaxed break-words">
          <p>{t('empty', { name: person.displayName })}</p>
          <p className="text-muted-foreground">{t('emptyHint')}</p>
        </section>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.month} aria-labelledby={`month-${group.month}`} className="flex flex-col gap-3">
              <h2 id={`month-${group.month}`} className="text-xl font-semibold">
                {formatMonth(`${group.month}-01`, locale)}
              </h2>
              <ul className="flex flex-col gap-3">
                {group.items.map((item) => (
                  <PersonFavoriteItem key={`${item.conversationId}:${item.id}`} item={item} personId={person.id} onRemove={onRemove} />
                ))}
              </ul>
            </section>
          ))}
          <div className="flex flex-col items-start gap-2">
            {items.length < total && (
              <p role="status" className="text-muted-foreground text-sm">
                {t('shown', { shown: items.length, total })}
              </p>
            )}
            {moreFailed && (
              <p role="alert" className="text-destructive text-sm">
                {t('moreFailed')}
              </p>
            )}
            {items.length < total && (
              <Button variant="outline" onClick={loadMore} aria-disabled={loadingMore || undefined} className="min-h-11 aria-disabled:pointer-events-none aria-disabled:opacity-50">
                {loadingMore && <Loader className="motion-safe:animate-spin" aria-hidden />}
                {loadingMore ? t('loadingMore') : t('showMore')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
