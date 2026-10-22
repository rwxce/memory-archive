'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { AudioHero } from '@/components/audio-hero';
import { LibraryNotice } from '@/components/library-notice';
import { PersonAudioItem, useAudioAuthor } from '@/components/person-audio-item';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { Shell } from '@/components/screen-shell';
import { ShowMore } from '@/components/show-more';
import { useLibrary } from '@/hooks/use-library';
import { useMediaUrl } from '@/hooks/use-media-url';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonMedia } from '@/hooks/use-person-media';
import type { PersonMediaItem } from '@/lib/domain/library';

const KINDS = ['audio'] as const;

/** Consecutive items of the same year (`sentAt` stamps, oldest first). */
function groupByYear(items: PersonMediaItem[]): Array<{ year: string; items: PersonMediaItem[] }> {
  const groups: Array<{ year: string; items: PersonMediaItem[] }> = [];
  for (const item of items) {
    const year = item.sentAt.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last?.year === year) last.items.push(item);
    else groups.push({ year, items: [item] });
  }
  return groups;
}

/**
 * A person's audio: every voice message and audio file of every conversation kept under them,
 * oldest first, by year. The person is chosen by `?id=` (a static export has no dynamic routes).
 * Rows come 50 at a time with "Show more". A file is read only when its Play is pressed, and one
 * shared player ("Now playing") plays it, so only one item ever plays at a time.
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

function Hero({
  item,
  personId,
  audio,
  playing,
  elapsed,
  duration,
  onToggle,
  onPlaying,
  onTime,
  onDuration,
}: Omit<React.ComponentProps<typeof AudioHero>, 'author' | 'media'> & {
  onPlaying: (playing: boolean) => void;
  onTime: (seconds: number) => void;
  onDuration: (seconds: number) => void;
}) {
  const author = useAudioAuthor(item);
  const media = useMediaUrl({ sha256: item.mediaSha256, mime: item.mediaMime, name: item.mediaName });
  return (
    <>
      <AudioHero item={item} author={author} personId={personId} media={media} playing={playing} elapsed={elapsed} duration={duration} audio={audio} onToggle={onToggle} />
      {/* The one player of the screen: no controls of its own (the hero is its face). */}
      <audio
        ref={audio}
        src={media.status === 'ready' ? media.url : undefined}
        autoPlay
        preload="none"
        aria-label={author}
        hidden
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
        onEnded={() => onPlaying(false)}
        onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
        onDurationChange={(event) => onDuration(event.currentTarget.duration)}
      />
    </>
  );
}

function PersonAudioContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personAudio');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: media, loadMore, retry } = usePersonMedia(id, KINDS);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<PersonMediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [durations, setDurations] = useState<Record<number, number>>({});
  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });

  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void Promise.resolve(element.play?.()).catch(() => setPlaying(false));
    else element.pause();
  }, []);
  const choose = (item: PersonMediaItem) => {
    if (current?.id === item.id) return toggle();
    setCurrent(item);
    setElapsed(0);
    setPlaying(false);
  };

  if (details.status === 'not-found' || media.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || media.status === 'error') {
    return (
      <Shell back={person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : retry}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (!person || media.status === 'loading') {
    return (
      <Shell>
        <LoadingNote>{t('loading')}</LoadingNote>
      </Shell>
    );
  }

  const { items, total, loadingMore, moreFailed } = media;
  const groups = groupByYear(items);
  const currentDuration = current ? durations[current.id] : undefined;
  return (
    <Shell back={personBack}>
      <header className="flex items-end justify-between gap-3 px-1">
        <h1 className="font-display text-display">{t('title')}</h1>
        <p className="text-mu pb-1.5 text-end text-sm break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>

      {current && (
        <Hero
          key={current.id}
          item={current}
          personId={person.id}
          audio={audio}
          playing={playing}
          elapsed={elapsed}
          duration={currentDuration}
          onToggle={toggle}
          onPlaying={setPlaying}
          onTime={setElapsed}
          onDuration={(seconds) => {
            if (Number.isFinite(seconds) && seconds > 0) setDurations((all) => ({ ...all, [current.id]: seconds }));
          }}
        />
      )}

      {total === 0 ? (
        <EmptyNote>{t('empty', { name: person.displayName })}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.year} aria-labelledby={`year-${group.year}`} className="flex flex-col gap-2.5">
              <h2 id={`year-${group.year}`} className="font-display text-name px-1 sm:text-3xl">
                {group.year}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <PersonAudioItem
                    key={item.id}
                    item={item}
                    current={current?.id === item.id}
                    playing={playing}
                    duration={durations[item.id]}
                    onToggle={() => choose(item)}
                  />
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
