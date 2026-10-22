'use client';

import { useRef } from 'react';
import { ImageOff, Images, NotebookPen, Play, Star } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useTileImage } from '@/hooks/use-tile-image';
import type { PersonOverview } from '@/hooks/use-person-overview';
import { Link } from '@/i18n/navigation';
import type { PersonMediaItem } from '@/lib/domain/library';
import { cn } from '@/components/ui/utils';
import { waveformHeights } from './waveform';

const card = 'min-w-0 [overflow-wrap:anywhere] focus-visible:ring-ring/50 rounded-3xl outline-none focus-visible:ring-[3px]';
const surface = 'bg-sf lg:in-data-panel:bg-bg';

/** Messages, photos and videos, voice messages: big serif numbers over small labels. */
export function PersonStats({ overview, className }: { overview: PersonOverview; className?: string }) {
  const t = useTranslations('person');
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const stats = [
    { id: 'messages', value: overview.messages, label: t('statMessages') },
    { id: 'pictures', value: overview.pictures, label: t('statPictures') },
    { id: 'voice', value: overview.voice, label: t('statVoice') },
  ];
  return (
    <dl className={cn('grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 lg:flex lg:gap-8', className)}>
      {stats.map(({ id, value, label }) => (
        <div key={id} className={cn('bg-sf flex flex-col-reverse gap-0.5 rounded-2xl p-3 lg:in-data-panel:bg-bg lg:bg-transparent! lg:p-0', 'min-w-0')}>
          <dt className="text-mu text-xs [overflow-wrap:anywhere]">{label}</dt>
          <dd className="font-display text-[1.875rem] leading-none lg:text-4xl">{number.format(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Thumb({ item, className }: { item: PersonMediaItem; className?: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(frame);
  const image = useTileImage(item, near);
  return (
    <span ref={frame} aria-hidden className={cn('bg-sf2 relative block aspect-square overflow-hidden rounded-[10px]', className)}>
      {image.status === 'ready' ? (
        <img src={image.url} alt="" decoding="async" className="size-full object-cover" />
      ) : image.status === 'missing' || image.status === 'error' ? (
        <ImageOff className="text-mu absolute inset-0 m-auto size-5" />
      ) : null}
    </span>
  );
}

/** Messages per year as bars: the busiest year is the tallest. Decorative; the card's text carries the meaning. */
function YearBars({ years }: { years: PersonOverview['years'] }) {
  const peak = Math.max(1, ...years.map((y) => y.count));
  const middle = years[Math.floor((years.length - 1) / 2)];
  return (
    <>
      <div aria-hidden className="flex h-[46px] items-end gap-1 lg:h-24 lg:gap-1.5">
        {years.map((y, i) => (
          <div key={y.year} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
            <div
              className={cn('w-full rounded-t-[4px] rounded-b-[1px]', ['bg-ph-0', 'bg-ph-1', 'bg-ph-2', 'bg-ph-3', 'bg-ph-4', 'bg-ph-5'][i % 6])}
              style={{ height: `${Math.max(6, Math.round((y.count / peak) * 100))}%` }}
            />
          </div>
        ))}
      </div>
      {years.length > 0 && (
        <>
          <div aria-hidden className="text-t2 flex justify-between text-[11px] lg:hidden">
            <span>{years[0].year}</span>
            {years.length > 2 && <span>{middle.year}</span>}
            {years.length > 1 && <span>{years[years.length - 1].year}</span>}
          </div>
          <div aria-hidden className="text-t2 hidden gap-1.5 text-[11px] lg:flex">
            {years.map((y) => (
              <span key={y.year} className="min-w-0 flex-1 text-center">
                {y.year}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * The bento of sections: Timeline (with a bar per year), Gallery (real thumbnails), Audio
 * (decorative waveform), Favorites and Notes (counts). Each card is one link with a name that says
 * what is behind it. Everything here is a preview: the sections themselves are separate screens.
 */
export function PersonBento({ personId, overview }: { personId: string; overview: PersonOverview | undefined }) {
  const t = useTranslations('person');
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const id = encodeURIComponent(personId);
  const wave = waveformHeights(personId, 22);
  const bars = overview?.years ?? [];

  return (
    <nav aria-label={t('sectionsLabel')} className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 lg:gap-3.5">
      <Link href={`/person/timeline?id=${id}`} className={cn(card, 'bg-ac-soft col-span-full flex flex-col gap-3.5 p-[18px] lg:min-h-48 lg:gap-4 lg:p-[22px]')}>
        <span className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-base font-semibold [overflow-wrap:anywhere] lg:text-[17px]">{t('sectionTimeline')}</span>
          <span className="text-t2 min-w-0 text-[13px] [overflow-wrap:anywhere]">{t('timelineHint')}</span>
        </span>
        <YearBars years={bars} />
      </Link>

      <Link href={`/person/gallery?id=${id}`} className={cn(card, surface, 'flex flex-col gap-3 p-3.5 lg:p-4')}>
        {overview && overview.thumbs.length > 0 ? (
          <span className="grid grid-cols-2 gap-1 lg:grid-cols-3">
            {overview.thumbs.map((item, i) => (
              <Thumb key={item.id} item={item} className={i >= 4 ? 'max-lg:hidden' : undefined} />
            ))}
          </span>
        ) : (
          <span aria-hidden className="bg-sf2 flex aspect-[2/1] items-center justify-center rounded-[10px]">
            <Images className="text-mu size-6" />
          </span>
        )}
        <span>
          <span className="block text-[15px] font-semibold">{t('sectionGallery')}</span>
          {overview && <span className="text-mu block text-[13px]">{t('galleryCount', { count: overview.pictures })}</span>}
        </span>
      </Link>

      <Link href={`/person/audio?id=${id}`} className={cn(card, 'bg-mint flex flex-col justify-between gap-3 p-3.5 lg:p-4')}>
        <span aria-hidden className="bg-btn text-btn-ink flex size-[42px] items-center justify-center rounded-full">
          <Play className="size-4 fill-current" />
        </span>
        <span aria-hidden className="flex h-9 items-center gap-[3px] lg:h-10">
          {wave.map((h, i) => (
            <span key={i} className="bg-ink min-w-0 flex-1 rounded-sm" style={{ height: `${Math.round(h * 100)}%`, maxWidth: 3 }} />
          ))}
        </span>
        <span>
          <span className="block text-[15px] font-semibold">{t('sectionAudio')}</span>
          {overview && <span className="text-t2 block text-[13px]">{t('audioCount', { count: overview.voice })}</span>}
        </span>
      </Link>

      <div className="col-span-full grid grid-cols-2 gap-2.5 lg:col-span-1 lg:grid-cols-1 lg:gap-3.5">
      <Link href={`/person/favorites?id=${id}`} className={cn(card, 'bg-butter flex items-center gap-2.5 rounded-[20px] p-3.5')}>
        <Star className="fill-star text-star size-[22px] shrink-0" aria-hidden />
        <span>
          <span className="block text-[15px] font-semibold">{t('sectionFavorites')}</span>
          {overview && <span className="text-t2 block text-[13px]">{number.format(overview.favorites)}</span>}
        </span>
      </Link>
      <Link href={`/person/notes?id=${id}`} className={cn(card, 'bg-ac-soft flex items-center gap-2.5 rounded-[20px] p-3.5')}>
        <NotebookPen className="text-ac-tx size-[22px] shrink-0" aria-hidden />
        <span>
          <span className="block text-[15px] font-semibold">{t('sectionNotes')}</span>
          {overview && <span className="text-t2 block text-[13px]">{number.format(overview.notes)}</span>}
        </span>
      </Link>
      </div>
    </nav>
  );
}
