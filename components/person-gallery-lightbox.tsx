'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, ImageIcon, Loader, Star, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useLightboxMedia } from '@/hooks/use-lightbox-media';
import { Link } from '@/i18n/navigation';
import type { PersonMediaItem } from '@/lib/domain/library';
import { formatDayTime } from './format';
import { galleryItemHref } from './person-gallery-href';
import { PillButton } from './pill-button';

const note = 'text-mu flex flex-col items-center gap-2 px-6 text-center text-sm break-words';
const padding = 'pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]';

/** A video holds its file only while it is the one shown; leaving it stops and releases it. */
function LightboxVideo({ url, label }: { url: string; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute('src');
      if (typeof element.load === 'function') element.load();
    };
  }, []);
  return <video ref={video} src={url} controls preload="metadata" aria-label={label} className="max-h-full max-w-full" />;
}

function Stage({ item, next }: { item: PersonMediaItem; next?: PersonMediaItem }) {
  const tm = useTranslations('conversation.media');
  const t = useTranslations('personGallery');
  const media = useLightboxMedia(item, next);
  const kind = t(item.type === 'video' ? 'video' : 'photo');
  const name = item.mediaName || kind;
  if (media.status === 'ready') {
    return item.type === 'video' ? (
      <LightboxVideo key={item.id} url={media.url} label={name} />
    ) : (
      // Fitted to the dialog, never enlarged past its own size. The caption below is the text.
      <img key={item.id} src={media.url} alt={name} className="max-h-full max-w-full object-contain" />
    );
  }
  if (media.status === 'missing' || media.status === 'error') {
    return (
      <p className={note}>
        <ImageOff className="size-8" aria-hidden />
        {tm(media.status)}
      </p>
    );
  }
  return (
    <p role="status" className={note}>
      <ImageIcon className="text-mu/60 size-8 motion-safe:animate-pulse" aria-hidden />
      {tm('loading', { name })}
    </p>
  );
}

interface Props {
  items: PersonMediaItem[];
  index: number;
  total: number;
  personId: string;
  loadingMore: boolean;
  moreFailed: boolean;
  onIndexChange(index: number): void;
  onClose(): void;
  loadMore(): void;
  onToggleFavorite(item: PersonMediaItem): void;
  favoriteFailed: boolean;
}

/**
 * The item full size in a native modal `<dialog>` (focus is trapped and returned by the browser,
 * Escape closes it). Previous / Next and the arrow keys walk the loaded items; at the last loaded
 * one, Next asks for the next page and moves on when it arrives. Only the open item and, when idle,
 * the next photo hold a file (`useLightboxMedia`). Names, authors and captions are untrusted text.
 */
export function PersonGalleryLightbox({ items, index, total, personId, loadingMore, moreFailed, onIndexChange, onClose, loadMore, onToggleFavorite, favoriteFailed }: Props) {
  const t = useTranslations('personGallery');
  const tf = useTranslations('conversation.favorite');
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const waiting = useRef(false);
  const item = items[index];
  const next = items[index + 1];
  const atStart = index <= 0;
  const atEnd = index >= items.length - 1 && items.length >= total;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  // The page Next asked for arrived: move on to its first item. If it failed, stay put.
  useEffect(() => {
    if (waiting.current && index + 1 < items.length) {
      waiting.current = false;
      onIndexChange(index + 1);
    }
  }, [items.length, index, onIndexChange]);
  useEffect(() => {
    if (moreFailed) waiting.current = false;
  }, [moreFailed]);

  const previous = () => {
    if (!atStart) onIndexChange(index - 1);
  };
  const forward = () => {
    if (index < items.length - 1) onIndexChange(index + 1);
    else if (items.length < total && !loadingMore) {
      waiting.current = true;
      loadMore();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // A video's own controls use the arrows to seek.
    if (event.defaultPrevented || (event.target as Element).tagName === 'VIDEO') return;
    if (event.key === 'ArrowLeft') previous();
    else if (event.key === 'ArrowRight') forward();
    else return;
    event.preventDefault();
  };

  if (!item) return null;
  const kind = t(item.type === 'video' ? 'video' : 'photo');
  const when = formatDayTime(item.sentAt, locale);
  const navButton = 'min-h-11 min-w-11 aria-disabled:pointer-events-none aria-disabled:opacity-50';

  return (
    <dialog
      ref={dialog}
      aria-label={t('lightboxLabel', { kind, title: item.conversationTitle, when })}
      onClose={onClose}
      onCancel={onClose}
      onKeyDown={onKeyDown}
      className={`bg-bg text-foreground m-0 hidden h-dvh max-h-none w-dvw max-w-none flex-col gap-3 border-0 open:flex ${padding}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-display text-name break-words" dir="auto">
            {item.conversationTitle}
          </h2>
          <p className="text-mu text-sm break-words">
            {kind}, {when}
            {item.participantName ? (
              <>
                {' · '}
                <span dir="auto">{item.participantName}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PillButton
            variant="outlined"
            size="md"
            onClick={() => onToggleFavorite(item)}
            aria-label={item.isFavorite ? tf('remove') : tf('add')}
            aria-pressed={item.isFavorite}
            className={`size-11 px-0 ${item.isFavorite ? 'text-star' : 'text-mu'}`}
          >
            <Star aria-hidden className={item.isFavorite ? 'fill-star stroke-star' : undefined} />
          </PillButton>
          <PillButton variant="outlined" size="md" onClick={onClose} aria-label={t('close')} className="size-11 px-0">
            <X aria-hidden />
          </PillButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <Stage item={item} next={next} />
      </div>

      {item.body && (
        <p className="max-h-24 overflow-y-auto text-sm break-words whitespace-pre-wrap" dir="auto">
          {item.body}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {favoriteFailed && (
          <p role="alert" className="text-destructive text-sm">
            {tf('failed')}
          </p>
        )}
        {moreFailed && (
          <p role="alert" className="text-destructive text-sm">
            {t('moreFailed')}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PillButton variant="outlined" onClick={previous} aria-disabled={atStart || undefined} className={navButton}>
              <ChevronLeft aria-hidden />
              {t('previous')}
            </PillButton>
            <PillButton variant="outlined" onClick={forward} aria-disabled={atEnd || undefined} className={navButton}>
              {t('next')}
              <ChevronRight aria-hidden />
            </PillButton>
          </div>
          <p role="status" className="text-mu flex items-center gap-2 text-sm">
            {loadingMore && <Loader className="size-4 motion-safe:animate-spin" aria-hidden />}
            {loadingMore ? t('loadingNext') : t('position', { current: index + 1, total: items.length })}
          </p>
          <Link
            href={galleryItemHref(item, personId)}
            className="text-ac-tx focus-visible:ring-ring/50 flex min-h-11 items-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]"
          >
            {t('openInConversation')}
          </Link>
        </div>
      </div>
    </dialog>
  );
}
