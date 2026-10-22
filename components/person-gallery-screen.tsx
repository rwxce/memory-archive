'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonGalleryLightbox } from '@/components/person-gallery-lightbox';
import { PersonGalleryTile } from '@/components/person-gallery-tile';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { Shell } from '@/components/screen-shell';
import { SegmentedControl } from '@/components/segmented-control';
import { MonthHeading } from '@/components/month-heading';
import { ShowMore } from '@/components/show-more';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonMedia } from '@/hooks/use-person-media';
import { groupByMonth } from './group-by-month';

const ALL = ['photo', 'video'] as const;
const PHOTOS = ['photo'] as const;
const VIDEOS = ['video'] as const;
type Filter = 'all' | 'photo' | 'video';
const KINDS = { all: ALL, photo: PHOTOS, video: VIDEOS } as const;

/**
 * A person's photos and videos: every one of every conversation kept under them, oldest first, as
 * a grid under month headings, with a Photos / Videos filter. The person is chosen by `?id=` (a
 * static export has no dynamic routes). Tiles come 50 at a time with "Show more" (a plain paged
 * grid, not virtualized: tiles are cheap, the DOM only grows as far as the person asks, and a photo
 * is read only while its tile is near the screen). Each tile opens the item in a full-screen
 * lightbox, which links on to the message in its conversation.
 */
export function PersonGalleryScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonGalleryContent onRetry={retry} />;
}

function PersonGalleryContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personGallery');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const [filter, setFilter] = useState<Filter>('all');
  const { state: media, loadMore, retry } = usePersonMedia(id, KINDS[filter]);
  const [openId, setOpenId] = useState<number | null>(null);
  const tileRefs = useRef(new Map<number, HTMLButtonElement>());
  const lastOpen = useRef<number | null>(null);
  lastOpen.current = openId ?? lastOpen.current;
  const closeLightbox = useCallback(() => {
    setOpenId(null);
    // Back to the tile the person was last looking at.
    const last = lastOpen.current;
    if (last !== null) requestAnimationFrame(() => tileRefs.current.get(last)?.focus());
  }, []);
  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });

  if (details.status === 'not-found' || media.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || media.status === 'error') {
    return (
      <Shell back={id && person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : retry}>{t('loadFailed')}</ErrorNote>
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

  const ready = media.status === 'ready' ? media : undefined;
  const items = ready?.items ?? [];
  const total = ready?.total ?? 0;
  const groups = groupByMonth(items);
  const openIndex = openId === null ? -1 : items.findIndex((item) => item.id === openId);
  const countKey = filter === 'photo' ? 'countPhotos' : filter === 'video' ? 'countVideos' : 'count';
  return (
    <Shell back={personBack}>
      <header className="flex items-end justify-between gap-3 px-1">
        <h1 className="font-display text-display">{t('title')}</h1>
        {ready && <p className="text-mu pb-1.5 text-end text-sm break-words">{t(countKey, { count: total, name: person.displayName })}</p>}
      </header>
      <SegmentedControl<Filter>
        label={t('filterLabel')}
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: t('filterAll') },
          { value: 'photo', label: t('filterPhotos') },
          { value: 'video', label: t('filterVideos') },
        ]}
      />

      {!ready ? (
        <LoadingNote>{t('loading')}</LoadingNote>
      ) : total === 0 ? (
        <EmptyNote>{t(filter === 'all' ? 'empty' : 'emptyFiltered', { name: person.displayName })}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.month} aria-labelledby={`month-${group.month}`} className="flex flex-col gap-2.5">
              <MonthHeading id={`month-${group.month}`} month={group.month} />
              <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 sm:gap-1.5 md:grid-cols-5 xl:grid-cols-6">
                {group.items.map((item, index) => (
                  <PersonGalleryTile
                    key={item.id}
                    item={item}
                    large={index === 0 && group.items.length >= 3}
                    onOpen={setOpenId}
                    buttonRef={(element) => {
                      if (element) tileRefs.current.set(item.id, element);
                      else tileRefs.current.delete(item.id);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
          <ShowMore
            shown={items.length}
            total={total}
            loading={ready.loadingMore}
            failed={ready.moreFailed}
            onMore={loadMore}
            labels={{ shown: t('shown', { shown: items.length, total }), moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
          />
        </div>
      )}
      {ready && openIndex >= 0 && (
        <PersonGalleryLightbox
          items={items}
          index={openIndex}
          total={total}
          personId={person.id}
          loadingMore={ready.loadingMore}
          moreFailed={ready.moreFailed}
          onIndexChange={(i) => setOpenId(items[i]?.id ?? null)}
          onClose={closeLightbox}
          loadMore={loadMore}
        />
      )}
    </Shell>
  );
}
