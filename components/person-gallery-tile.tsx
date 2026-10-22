'use client';

import { useRef, useState } from 'react';
import { ImageIcon, ImageOff, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { useTileImage } from '@/hooks/use-tile-image';
import { Link } from '@/i18n/navigation';
import type { PersonMediaItem } from '@/lib/domain/library';
import { formatDayTime } from './format';

const note = 'text-muted-foreground flex flex-col items-center gap-1 px-2 text-center text-xs break-words';

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
    inner = <ImageIcon className="text-muted-foreground/50 size-6 motion-safe:animate-pulse" aria-hidden />;
  }
  return (
    <span ref={frame} className="absolute inset-0 flex items-center justify-center">
      {inner}
    </span>
  );
}

/** A video is not read here: a play glyph and its file name, until it is opened in the conversation. */
function VideoFace({ item }: { item: PersonMediaItem }) {
  const t = useTranslations('personGallery');
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2">
      <span className="bg-background/80 text-foreground flex size-10 items-center justify-center rounded-full border">
        <Play className="size-5" aria-hidden />
      </span>
      <span className="text-muted-foreground line-clamp-2 w-full text-center text-xs break-all" dir="auto">
        {item.mediaName || t('videoName')}
      </span>
    </span>
  );
}

/**
 * One square tile: a link that opens the message in its conversation, on that day. Its size never
 * depends on the picture (no layout shift as photos arrive). Names are untrusted text.
 */
export function PersonGalleryTile({ item, personId }: { item: PersonMediaItem; personId: string }) {
  const t = useTranslations('personGallery');
  const locale = useLocale();
  const isVideo = item.type === 'video';
  const href = `/conversation?id=${encodeURIComponent(item.conversationId)}&from=${encodeURIComponent(personId)}&date=${item.sentAt.slice(0, 10)}`;
  const label = t('tileLabel', { title: item.conversationTitle, kind: t(isVideo ? 'video' : 'photo'), when: formatDayTime(item.sentAt, locale) });
  return (
    <li>
      <Link
        href={href}
        aria-label={label}
        className="bg-muted hover:bg-muted/70 focus-visible:ring-ring/50 relative block aspect-square min-h-11 overflow-hidden rounded-lg border outline-none focus-visible:ring-[3px]"
      >
        {isVideo ? <VideoFace item={item} /> : <Picture item={item} />}
      </Link>
    </li>
  );
}
