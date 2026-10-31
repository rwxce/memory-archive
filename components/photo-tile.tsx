'use client';

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, ImageIcon, ImageOff, Play, UserCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { usePhotoImage } from '@/hooks/use-photo-image';
import type { PhotoDisplayDate, PhotoPicture } from '@/lib/domain/photo';
import { cn } from '@/components/ui/utils';
import { shownDate } from './photo-days';
import { safeName } from './safe-name';

const LONG_PRESS_MS = 500;
/** After a long press ends, the click it may leave behind is swallowed for this long; a tap later than that is a tap. */
const SWALLOW_CLICK_MS = 400;
const note = 'text-mu flex flex-col items-center gap-1 px-2 text-center text-xs break-words';

/** `2026-03-13` and `14:05` as one calm sentence-ready string, in the zone the date rule already chose. */
export function useWhen() {
  const format = useFormatter();
  return (when: PhotoDisplayDate, style: 'tile' | 'long' = 'long') => {
    const instant = new Date(`${when.day}T${when.time || '00:00'}:00Z`);
    return style === 'tile'
      ? format.dateTime(instant, { dateStyle: 'medium', timeZone: 'UTC' })
      : format.dateTime(instant, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
  };
}

function Face({ picture, near }: { picture: PhotoPicture; near: boolean }) {
  const t = useTranslations('photos.select.tile');
  const image = usePhotoImage(picture, 'tile', near);
  const [broken, setBroken] = useState<string>();
  if (picture.kind === 'video' || image.status === 'no-preview') {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2" data-testid={picture.kind === 'video' ? undefined : 'photo-tile-no-preview'}>
        {picture.kind !== 'video' && <ImageIcon className="text-mu/60 size-6" aria-hidden />}
        <span className="text-t2 line-clamp-3 w-full text-center text-xs break-all" dir="auto">
          {safeName(picture.fileName, 60) || t(picture.kind === 'video' ? 'video' : 'photo')}
        </span>
        {picture.kind === 'video' && (
          <span className="absolute end-1.5 bottom-1.5 inline-flex items-center rounded-full bg-black/60 px-2 py-1 text-white">
            <Play className="size-3" fill="currentColor" aria-hidden />
          </span>
        )}
      </span>
    );
  }
  if (image.status === 'ready' && broken !== image.url) {
    // The tile's name carries the meaning; the picture is decoration.
    return <img src={image.url} alt="" decoding="async" draggable={false} onError={() => setBroken(image.url)} className="absolute inset-0 size-full object-cover" />;
  }
  if (image.status === 'ready' || image.status === 'missing' || image.status === 'error' || image.status === 'too-large') {
    return (
      <span className={cn(note, 'absolute inset-0 justify-center')} data-testid="photo-tile-failed">
        <ImageOff className="size-5" aria-hidden />
        {t('failed')}
      </span>
    );
  }
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <ImageIcon className="text-mu/60 size-6 motion-safe:animate-pulse" aria-hidden />
    </span>
  );
}

interface TileProps {
  picture: PhotoPicture;
  selected: boolean;
  /** Roving tabindex: only one tile of the grid is in the tab order. */
  tabbable: boolean;
  onSelect(picture: PhotoPicture, event: { shift: boolean; toggle: boolean }): void;
  onOpen(picture: PhotoPicture): void;
  onLongPress(picture: PhotoPicture): void;
  /** Whether a plain tap/click chooses (selecting mode) or opens the picture. */
  selecting: boolean;
}

/**
 * One square tile: an `option` of the grid. Its size never depends on the picture. Tap or click opens the picture, or
 * chooses it while selecting; Shift/Ctrl/Cmd-click always chooses; a long press on a touch screen starts selecting.
 * Space chooses, Enter opens (or chooses while selecting). Names and dates are text only.
 */
export const PhotoTile = memo(function PhotoTile({ picture, selected, tabbable, onSelect, onOpen, onLongPress, selecting }: TileProps) {
  const t = useTranslations('photos.select.tile');
  const show = useWhen();
  const frame = useRef<HTMLDivElement>(null);
  const near = useNearViewport(frame);
  const when = useMemo(() => shownDate(picture), [picture]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressed = useRef(false);
  const swallow = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(swallow.current);
    },
    [],
  );
  // The press is over: the click it leaves behind (if any) comes right now, so anything later is a new tap.
  const released = () => {
    clearTimeout(timer.current);
    if (!pressed.current) return;
    clearTimeout(swallow.current);
    swallow.current = setTimeout(() => (pressed.current = false), SWALLOW_CLICK_MS);
  };

  const kind = t(picture.kind === 'video' ? 'video' : 'photo');
  const parts = [kind, when ? (when.approximate ? t('about', { date: show(when) }) : show(when)) : t('noDate')];
  if (picture.assignedProfileIds.length > 0) parts.push(t('assigned'));
  const label = parts.join(', ');

  const onClick = (event: MouseEvent) => {
    if (pressed.current) {
      pressed.current = false;
      clearTimeout(swallow.current);
      return;
    }
    const modifier = event.shiftKey || event.ctrlKey || event.metaKey;
    if (selecting || modifier) onSelect(picture, { shift: event.shiftKey, toggle: true });
    else onOpen(picture);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault();
      onSelect(picture, { shift: event.shiftKey, toggle: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (selecting) onSelect(picture, { shift: event.shiftKey, toggle: true });
      else onOpen(picture);
    }
  };

  return (
    <div
      ref={frame}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      data-photo={picture.sha256}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || selecting) return;
        timer.current = setTimeout(() => {
          pressed.current = true;
          onLongPress(picture);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={released}
      onPointerCancel={released}
      onPointerLeave={released}
      onContextMenu={(event) => {
        // A long press on a touch screen would otherwise open the browser's own menu over the choice.
        if (pressed.current) event.preventDefault();
      }}
      className={cn(
        'bg-sf2 hover:bg-line relative aspect-square min-h-11 w-full cursor-pointer touch-manipulation overflow-hidden rounded-xl outline-none select-none',
        'focus-visible:outline-ring focus-visible:outline-[3px] focus-visible:outline-offset-2',
        selected && 'ring-ac ring-4 ring-inset',
      )}
    >
      <Face picture={picture} near={near} />
      {selected && <span className="bg-ac/20 absolute inset-0" aria-hidden />}
      <span
        aria-hidden
        className={cn('absolute start-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full border-2', selected ? 'bg-ac border-ac text-ac-ink' : 'border-white bg-black/35 text-transparent')}
      >
        <Check className="size-4" strokeWidth={3} />
      </span>
      {picture.assignedProfileIds.length > 0 && (
        <span aria-hidden className="absolute end-1.5 top-1.5 inline-flex items-center rounded-full bg-black/60 p-1 text-white">
          <UserCheck className="size-3.5" />
        </span>
      )}
      {when?.approximate && (
        <span aria-hidden className="absolute start-1.5 bottom-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium text-white">
          {t('estimated')}
        </span>
      )}
    </div>
  );
});
