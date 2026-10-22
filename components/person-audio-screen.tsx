'use client';

import { useState } from 'react';
import { ArrowLeft, Loader } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonAudioItem } from '@/components/person-audio-item';
import { PersonSections } from '@/components/person-sections';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonMedia } from '@/hooks/use-person-media';
import { Link } from '@/i18n/navigation';
import { formatMonth } from './format';
import { groupByMonth } from './group-by-month';

const KINDS = ['audio'] as const;

const linkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

/**
 * A person's audio: every voice message and audio file of every conversation kept under them,
 * oldest first, by month. The person is chosen by `?id=` (a static export has no dynamic routes).
 * Rows come 50 at a time with "Show more"; a file is read only when its Play is pressed, and only
 * one plays at a time.
 */
export function PersonAudioScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonAudioContent onRetry={retry} />;
}

function PersonAudioContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personAudio');
  const tp = useTranslations('person');
  const tl = useTranslations('library');
  const locale = useLocale();
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: media, loadMore, retry } = usePersonMedia(id, KINDS);
  const [playing, setPlaying] = useState<number | null>(null);

  if (details.status === 'not-found' || media.status === 'not-found') {
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
  if (details.status === 'error' || media.status === 'error') {
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
  if (details.status === 'loading' || media.status === 'loading') {
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
  const { items, total, loadingMore, moreFailed } = media;
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
      <PersonSections personId={person.id} current="audio" />

      {total === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border p-5 leading-relaxed break-words">{t('empty', { name: person.displayName })}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.month} aria-labelledby={`month-${group.month}`} className="flex flex-col gap-3">
              <h2 id={`month-${group.month}`} className="text-xl font-semibold">
                {formatMonth(`${group.month}-01`, locale)}
              </h2>
              <ul className="flex flex-col gap-3">
                {group.items.map((item) => (
                  <PersonAudioItem key={item.id} item={item} personId={person.id} active={playing === item.id} onPlay={() => setPlaying(item.id)} />
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
