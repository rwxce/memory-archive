'use client';

import { useRef, useState } from 'react';
import { ImageIcon, ImageOff, Play, Star } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useTileImage } from '@/hooks/use-tile-image';
import type { PersonMediaItem } from '@/lib/domain/library';
import { formatDayTime } from './format';

const note = 'text-mu flex flex-col items-center gap-1 px-2 text-center text-xs break-words';

/** What a tile shows: the photo when it is near the screen, otherwise a quiet placeholder. */
function Picture({ item }: { item: PersonMediaItem }) {
  const tm = useTranslations('conversation.media');
  const frame = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(frame);
  const image = useTileImage(item, near);
  const [broken, setBroken] = useState<string>();

  let inner;
  if (image.status === 'ready' && broken !== image.url) {
    // The link carries the name; the picture is decoration.
    inner = <img src={image.url} alt="" decoding="async" onError={() => setBroken(image.url)} className="size-full object-cover" />;
  } else if (image.status === 'missing' || image.status === 'error' || image.status === 'ready') {
    inner = (
      <span className={note}>
        <ImageOff className="size-5" aria-hidden />
        {tm(image.status === 'missing' ? 'missing' : 'error')}
      </span>
    );
  } else {
    inner = <ImageIcon className="text-mu/60 size-6 motion-safe:animate-pulse" aria-hidden />;
  }
  return (
    <span ref={frame} className="absolute inset-0 flex items-center justify-center">
      {inner}
    </span>
  );
}

/**
 * A video is not read here (that would load its file for every tile): a play badge and its file
 * name, until it is opened. Its length is shown in the lightbox once the player knows it.
 */
function VideoFace({ item }: { item: PersonMediaItem }) {
  const t = useTranslations('personGallery');
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center p-2">
      <span className="text-t2 line-clamp-3 w-full text-center text-xs break-all" dir="auto">
        {item.mediaName || t('videoName')}
      </span>
      <span className="absolute end-1.5 bottom-1.5 inline-flex items-center rounded-full bg-black/55 px-2 py-1 text-white">
        <Play className="size-3" fill="currentColor" aria-hidden />
      </span>
    </span>
  );
}

/**
 * One square tile: a button that opens the item full size. Its size never depends on the picture
 * (no layout shift as photos arrive). Names are untrusted text.
 */
export function PersonGalleryTile({ item, onOpen, buttonRef, large = false }: { item: PersonMediaItem; onOpen: (id: number) => void; large?: boolean; buttonRef?: (element: HTMLButtonElement | null) => void }) {
  const t = useTranslations('personGallery');
  const locale = useLocale();
  const isVideo = item.type === 'video';
  const base = t('tileLabel', { title: item.conversationTitle, kind: t(isVideo ? 'video' : 'photo'), when: formatDayTime(item.sentAt, locale) });
  const label = item.isFavorite ? `${base}, ${t('favorite')}` : base;
  return (
    <li className={large ? 'col-span-2 row-span-2' : undefined}>
      <button
        type="button"
        ref={buttonRef}
        onClick={() => onOpen(item.id)}
        aria-label={label}
        className={`bg-sf2 hover:bg-line focus-visible:ring-ring/50 relative block aspect-square w-full min-h-11 overflow-hidden outline-none focus-visible:ring-[3px] ${large ? 'rounded-[18px]' : 'rounded-xl'}`}
      >
        {isVideo ? <VideoFace item={item} /> : <Picture item={item} />}
        {item.isFavorite && (
          // Decoration: the favorite state is in the button's name. The dark disc keeps it readable on any photo.
          <span data-testid="tile-star" className="absolute start-1.5 top-1.5 inline-flex items-center rounded-full bg-black/55 p-1">
            <Star className="fill-star stroke-star size-3.5" aria-hidden />
          </span>
        )}
      </button>
    </li>
  );
}
