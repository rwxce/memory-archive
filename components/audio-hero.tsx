'use client';

import type { RefObject } from 'react';
import { ImageOff, Pause, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { MediaState } from '@/hooks/use-media-url';
import { Link } from '@/i18n/navigation';
import type { PersonMediaItem } from '@/lib/domain/library';
import { formatClock } from './clock';
import { formatDayTime } from './format';
import { galleryItemHref } from './person-gallery-href';
import { Waveform } from './waveform';

/**
 * "Now playing": the big player of the Audio screen. The one `<audio>` of the screen is owned by
 * the screen (so a row can pause it too); this card shows its state: who and when, a decorative
 * waveform that fills as it plays (a hidden slider on top lets keyboard and screen-reader users
 * seek), elapsed and total time once the file's metadata is known, Play/Pause, and the way to the
 * message. Nothing is shown for the length until the player knows it.
 */
export function AudioHero({
  item,
  author,
  personId,
  media,
  playing,
  elapsed,
  duration,
  audio,
  onToggle,
}: {
  item: PersonMediaItem;
  author: string;
  personId: string;
  media: MediaState;
  playing: boolean;
  elapsed: number;
  duration: number | undefined;
  audio: RefObject<HTMLAudioElement | null>;
  onToggle: () => void;
}) {
  const t = useTranslations('personAudio');
  const tm = useTranslations('conversation.media');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const unavailable = media.status === 'missing' || media.status === 'error' || media.status === 'too-large';
  const ready = media.status === 'ready';
  const progress = duration && duration > 0 ? Math.min(1, elapsed / duration) : 0;
  return (
    <section aria-label={t('nowPlaying')} className="bg-ac text-ac-ink flex flex-col gap-4 rounded-[28px] p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-name truncate sm:text-3xl" dir="auto">
            {author}
          </p>
          <p className="text-out-mu text-sm break-words">
            {when}
            <span dir="auto">
              {' · '}
              {item.conversationTitle}
            </span>
          </p>
        </div>
        <Link
          href={galleryItemHref(item, personId)}
          aria-label={t('openLabel', { title: item.conversationTitle, when })}
          className="text-ac-ink focus-visible:ring-ac-ink/60 flex min-h-11 shrink-0 items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('open')}
        </Link>
      </div>

      {unavailable ? (
        <p role="note" className="flex min-h-14 items-center gap-2 text-sm">
          <ImageOff className="size-5 shrink-0" aria-hidden />
          {tm(media.status === 'missing' ? 'missing' : media.status === 'too-large' ? 'tooLarge' : 'error')}
        </p>
      ) : (
        <div className="focus-within:ring-ac-ink/60 relative rounded-lg focus-within:ring-[3px]">
          <Waveform seed={String(item.id)} bars={40} progress={progress} tone="on-accent" className="h-14 w-full justify-between gap-[3px]" />
          {ready && duration ? (
            <input
              type="range"
              aria-label={t('seek')}
              aria-valuetext={`${formatClock(elapsed)} / ${formatClock(duration)}`}
              min={0}
              max={Math.round(duration)}
              step={1}
              value={Math.round(elapsed)}
              onChange={(event) => {
                if (audio.current) audio.current.currentTime = Number(event.target.value);
              }}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          ) : null}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-out-mu min-w-10 text-xs tabular-nums">{ready ? formatClock(elapsed) : ''}</span>
        <button
          type="button"
          onClick={onToggle}
          disabled={unavailable}
          aria-label={t(playing ? 'pause' : 'play')}
          className="bg-ac-ink text-ac focus-visible:ring-ac-ink/60 flex size-[60px] items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:opacity-50"
        >
          {playing ? <Pause className="size-6" fill="currentColor" aria-hidden /> : <Play className="size-6" fill="currentColor" aria-hidden />}
        </button>
        <span className="text-out-mu min-w-10 text-end text-xs tabular-nums">{duration ? formatClock(duration) : ''}</span>
      </div>
    </section>
  );
}
