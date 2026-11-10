'use client';

import { useCallback, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { PersonPhotoTile } from '@/components/person-photo-tile';
import { PhotoDetailDialog } from '@/components/photo-detail-dialog';
import { groupByDay } from '@/components/photo-days';
import { PageTitle } from '@/components/page-title';
import { PillButton } from '@/components/pill-button';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { Shell } from '@/components/screen-shell';
import { ShowMore } from '@/components/show-more';
import { usePhotoAssign } from '@/hooks/use-photo-assign';
import { usePhotoGrid } from '@/hooks/use-photo-grid';
import { useLibrary } from '@/hooks/use-library';
import { usePeople } from '@/hooks/use-people';
import { usePersonDetails } from '@/hooks/use-person-details';
import { Link } from '@/i18n/navigation';
import { isUuid } from '@/lib/domain/library';

/**
 * The pictures of the photo collection that were assigned to one person: newest first, by day, in a grid; each one opens
 * in the same detail view as the selection screen (previous / next, and "Take out", after which it leaves this list).
 * The person is chosen by `?id=` (a static export has no dynamic routes). A plain paged grid with "Show more".
 */
export function PersonPhotosScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonPhotosContent onRetry={retry} />;
}

function PersonPhotosContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('person.photos');
  const tn = useTranslations('photos.select.day');
  const format = useFormatter();
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const valid = isUuid(id) ? id : undefined;
  const grid = usePhotoGrid('assigned', valid);
  const people = usePeople();
  const actions = usePhotoAssign();
  const [detail, setDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });
  const days = useMemo(() => groupByDay(grid.pictures), [grid.pictures]);
  const names = useMemo(() => new Map(people.status === 'ready' ? [...people.people.active, ...people.people.archived].map((p) => [p.id, p.displayName]) : []), [people]);
  const { loadMore } = grid;

  const open = useCallback((p: { sha256: string }) => setDetail(p.sha256), []);
  // Walking to another picture, or closing because none is left: then there is no tile to return to, so the heading gets focus.
  const walk = useCallback((sha: string | null) => {
    setDetail(sha);
    if (sha === null) setTimeout(() => document.querySelector<HTMLElement>('h1')?.focus(), 0);
  }, []);
  const close = useCallback((sha: string) => {
    setDetail(null);
    // The tile gets focus back; if it left the list (taken out), the heading does.
    setTimeout(() => (document.querySelector<HTMLElement>(`[data-photo="${sha}"]`) ?? document.querySelector<HTMLElement>('h1'))?.focus(), 0);
  }, []);

  if (details.status === 'not-found' || !valid) {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || grid.status === 'error') {
    return (
      <Shell back={person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : () => void grid.reload()}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (!person) {
    return (
      <Shell>
        <LoadingNote>{t('loading')}</LoadingNote>
      </Shell>
    );
  }

  const unassignOne = async (sha256: string, profileId: string) => {
    const ok = await actions.unassignOne(sha256, profileId);
    if (ok) {
      grid.patch((p) => (p.sha256 === sha256 ? { ...p, assignedProfileIds: p.assignedProfileIds.filter((other) => other !== profileId) } : p));
      if (profileId === valid) setNotice(t('takenOut', { name: person.displayName }));
      void grid.recount();
    }
    return ok;
  };

  const ready = grid.status === 'ready';
  const total = grid.profileTotal ?? grid.pictures.length;
  return (
    <Shell back={personBack} message={notice}>
      <header className="flex flex-col gap-1.5 px-1">
        <div className="flex items-end justify-between gap-3">
          <PageTitle tabIndex={-1}>{t('title')}</PageTitle>
          {ready && grid.profileTotal !== undefined && grid.profileTotal > 0 && <p className="text-mu pb-1.5 text-end text-sm break-words">{t('count', { count: grid.profileTotal })}</p>}
        </div>
        <p className="text-t2 leading-relaxed">{t('intro', { name: person.displayName })}</p>
      </header>

      {!ready ? (
        <LoadingNote>{t('loading')}</LoadingNote>
      ) : grid.pictures.length === 0 ? (
        <div className="flex flex-col items-start gap-3" data-testid="person-photos-empty">
          <EmptyNote>{t('empty', { name: person.displayName })}</EmptyNote>
          <PillButton asChild variant="outlined">
            <Link href="/photos/select">{t('choose')}</Link>
          </PillButton>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((day) => {
            const title = day.day === null ? tn('undated') : format.dateTime(new Date(`${day.day}T00:00:00Z`), { dateStyle: 'full', timeZone: 'UTC' });
            return (
              <section key={day.key} aria-labelledby={`day-${day.key}`} data-day={day.day ?? 'undated'} className="flex flex-col gap-2.5">
                <h2 id={`day-${day.key}`} className="min-w-0 px-1 text-base font-semibold break-words">
                  {title}
                  {day.allEstimated && day.day !== null && <span className="text-t2 ms-2 text-sm font-normal">({tn('estimated')})</span>}
                </h2>
                <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 sm:gap-1.5 md:grid-cols-5 xl:grid-cols-6">
                  {day.pictures.map((picture) => (
                    <PersonPhotoTile key={picture.sha256} picture={picture} onOpen={open} />
                  ))}
                </ul>
              </section>
            );
          })}
          {grid.hasMore && (
            <ShowMore
              shown={grid.pictures.length}
              total={Math.max(total, grid.pictures.length + 1)}
              loading={grid.loadingMore}
              failed={grid.moreFailed}
              onMore={() => void loadMore()}
              labels={{ shown: t('shown', { shown: grid.pictures.length, total }), moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
            />
          )}
        </div>
      )}
      <PhotoDetailDialog
        pictures={grid.pictures}
        openSha={detail}
        hasMore={grid.hasMore}
        loadingMore={grid.loadingMore}
        names={names}
        working={actions.working}
        onOpen={walk}
        onClose={close}
        loadMore={() => void loadMore()}
        onUnassign={unassignOne}
      />
    </Shell>
  );
}
