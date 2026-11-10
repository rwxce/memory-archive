'use client';

import { memo, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useNearViewport } from '@/hooks/use-near-viewport';
import type { PhotoPicture } from '@/lib/domain/photo';
import { shownDate } from './photo-days';
import { Face, useWhen } from './photo-tile';

/**
 * One square tile of a person's photos: a plain button that opens the picture (no selection here). Its size never
 * depends on the picture, which is read only while the tile is near the screen. The name says what it is and when.
 */
export const PersonPhotoTile = memo(function PersonPhotoTile({ picture, onOpen }: { picture: PhotoPicture; onOpen(picture: PhotoPicture): void }) {
  const t = useTranslations('photos.select.tile');
  const show = useWhen();
  const frame = useRef<HTMLButtonElement>(null);
  const near = useNearViewport(frame);
  const when = useMemo(() => shownDate(picture), [picture]);
  const label = [t(picture.kind === 'video' ? 'video' : 'photo'), when ? (when.approximate ? t('about', { date: show(when) }) : show(when)) : t('noDate')].join(', ');
  return (
    <li>
      <button
        ref={frame}
        type="button"
        aria-label={label}
        data-photo={picture.sha256}
        onClick={() => onOpen(picture)}
        className="bg-sf2 hover:bg-line focus-visible:outline-ring relative block aspect-square min-h-11 w-full cursor-pointer touch-manipulation overflow-hidden rounded-xl outline-none focus-visible:outline-[3px] focus-visible:outline-offset-2"
      >
        <Face picture={picture} near={near} />
      </button>
    </li>
  );
});
