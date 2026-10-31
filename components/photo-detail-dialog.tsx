'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, ImageIcon, ImageOff, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePhotoImage } from '@/hooks/use-photo-image';
import { PHOTO_PICTURE_ALBUMS_MAX, type PhotoPicture } from '@/lib/domain/photo';
import { PillButton } from './pill-button';
import { NAME_IN_ROW, safeName } from './safe-name';
import { shownDate } from './photo-days';
import { useWhen } from './photo-tile';

const note = 'text-mu flex flex-col items-center gap-2 px-6 text-center text-sm break-words';

/** A video holds its file only while it is the one shown; leaving it stops and releases it. */
function Video({ url, label }: { url: string; label: string }) {
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

function Stage({ picture }: { picture: PhotoPicture }) {
  const t = useTranslations('photos.select.detail');
  const media = usePhotoImage(picture, 'full', true);
  const name = safeName(picture.fileName, 80) || t(picture.kind === 'video' ? 'video' : 'photo');
  if (media.status === 'ready') {
    return picture.kind === 'video' ? <Video key={picture.sha256} url={media.url} label={name} /> : <img key={picture.sha256} src={media.url} alt={name} className="max-h-full max-w-full object-contain" />;
  }
  if (media.status === 'missing' || media.status === 'error' || media.status === 'too-large') {
    return (
      <p className={note}>
        <ImageOff className="size-8" aria-hidden />
        {t(media.status)}
      </p>
    );
  }
  return (
    <p role="status" className={note}>
      <ImageIcon className="text-mu/60 size-8 motion-safe:animate-pulse" aria-hidden />
      {t('loading')}
    </p>
  );
}

interface Props {
  pictures: readonly PhotoPicture[];
  /** The picture open, or null when closed. */
  openSha: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** Names of the profiles by id; a profile that is not known reads as "someone". */
  names: ReadonlyMap<string, string>;
  working: boolean;
  onOpen(sha256: string | null): void;
  onClose(lastSha256: string): void;
  loadMore(): void;
  onUnassign(sha256: string, profileId: string): Promise<boolean>;
}

/**
 * One picture full size in a native modal `<dialog>` (focus trapped and returned by the browser, Escape closes), with
 * where its date comes from, its albums and sources, and who it is assigned to (each with "Take out"). Previous / Next and
 * the arrow keys walk the loaded list. Names are untrusted text, clamped and isolated.
 */
export function PhotoDetailDialog({ pictures, openSha, hasMore, loadingMore, names, working, onOpen, onClose, loadMore, onUnassign }: Props) {
  const t = useTranslations('photos.select.detail');
  const ts = useTranslations('photos.batches.source');
  const show = useWhen();
  const dialog = useRef<HTMLDialogElement>(null);
  const last = useRef({ index: 0, sha: '' });
  const waiting = useRef(false);
  const [failed, setFailed] = useState(false);
  const found = openSha === null ? -1 : pictures.findIndex((p) => p.sha256 === openSha);
  const picture = found >= 0 ? pictures[found] : undefined;
  if (found >= 0) last.current = { index: found, sha: openSha! };

  // The picture left the list (it was taken out of the last profile of an "Assigned" list): show its neighbour, or close.
  useEffect(() => {
    if (openSha !== null && found < 0) onOpen(pictures[Math.min(last.current.index, pictures.length - 1)]?.sha256 ?? null);
  }, [openSha, found, pictures, onOpen]);

  const isOpen = picture !== undefined;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (isOpen && !element.open) element.showModal();
    if (!isOpen && element.open) element.close();
  }, [isOpen]);

  useEffect(() => {
    if (waiting.current && found >= 0 && found + 1 < pictures.length) {
      waiting.current = false;
      onOpen(pictures[found + 1].sha256);
    }
  }, [pictures, found, onOpen]);
  useEffect(() => setFailed(false), [openSha]);

  const atStart = found <= 0;
  const atEnd = found >= pictures.length - 1 && !hasMore;
  const previous = () => !atStart && onOpen(pictures[found - 1].sha256);
  const forward = () => {
    if (found < pictures.length - 1) onOpen(pictures[found + 1].sha256);
    else if (hasMore && !loadingMore) {
      waiting.current = true;
      loadMore();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('video')) return; // the player keeps its own arrow keys
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) previous();
    else if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) forward();
  };

  // The "Take out" that was pressed is gone with its row: focus goes to the next one (else the one before), and if none is
  // left, or the list moved on to another picture, to the "Assigned to" heading, so the keyboard never falls to the page.
  const settleFocus = (sha: string, at: number) =>
    setTimeout(() => {
      const root = dialog.current;
      if (!root) return;
      const buttons = [...root.querySelectorAll<HTMLElement>('[data-testid="detail-people"] button')];
      const target = last.current.sha === sha ? buttons[Math.min(at, buttons.length - 1)] : undefined;
      (target ?? root.querySelector<HTMLElement>('#detail-people'))?.focus();
    }, 0);

  const when = picture ? shownDate(picture) : null;
  const albumsHidden = picture ? picture.albumCount - picture.albums.length : 0;

  return (
    <dialog
      ref={dialog}
      aria-label={t('label')}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose(last.current.sha);
      }}
      className="bg-bg text-foreground m-0 h-dvh max-h-none w-screen max-w-none p-0 backdrop:bg-black/60 md:m-auto md:h-[min(90dvh,48rem)] md:w-[min(64rem,calc(100vw-3rem))] md:rounded-3xl"
    >
      {picture && (
        <div className="flex h-full flex-col md:grid md:grid-cols-[1fr_20rem]">
          <div className="bg-sf2 flex min-h-0 flex-1 flex-col md:rounded-s-3xl">
            <div className="flex items-center justify-between gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
              <p className="text-t2 ps-2 text-sm" aria-live="polite">
                {t(hasMore ? 'positionMore' : 'position', { current: found + 1, total: pictures.length })}
              </p>
              <PillButton variant="outlined" onClick={() => onClose(last.current.sha)} aria-label={t('close')} className="size-11 p-0">
                <X aria-hidden />
              </PillButton>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center p-2" data-testid="detail-stage">
              <Stage picture={picture} />
            </div>
            <div className="flex justify-between gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <PillButton variant="outlined" aria-disabled={atStart || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={previous}>
                <ChevronLeft aria-hidden className="rtl:rotate-180" />
                {t('previous')}
              </PillButton>
              <PillButton variant="outlined" aria-disabled={atEnd || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={forward}>
                {t('next')}
                <ChevronRight aria-hidden className="rtl:rotate-180" />
              </PillButton>
            </div>
          </div>
          <div className="flex max-h-[40dvh] flex-col gap-4 overflow-y-auto p-5 text-sm md:max-h-none">
            <dl className="flex flex-col gap-3">
              <div>
                <dt className="text-t2 text-xs font-semibold tracking-wide uppercase">{t('file')}</dt>
                <dd className="break-words" dir="auto">
                  <bdi>{safeName(picture.fileName, NAME_IN_ROW) || '—'}</bdi>
                </dd>
              </div>
              <div>
                <dt className="text-t2 text-xs font-semibold tracking-wide uppercase">{t('date')}</dt>
                <dd data-testid="detail-date">
                  {when ? (when.approximate ? t('dateAbout', { date: show(when) }) : show(when)) : t('dateUnknown')}
                  <span className="text-t2 block">{t(`from.${picture.dateSource}`)}</span>
                </dd>
              </div>
              {picture.albums.length > 0 && (
                <div>
                  <dt className="text-t2 text-xs font-semibold tracking-wide uppercase">{t('albums')}</dt>
                  <dd>
                    <ul className="flex flex-col gap-0.5">
                      {picture.albums.slice(0, PHOTO_PICTURE_ALBUMS_MAX).map((album) => (
                        <li key={album} className="line-clamp-2 break-words">
                          <bdi>{safeName(album, NAME_IN_ROW)}</bdi>
                        </li>
                      ))}
                    </ul>
                    {albumsHidden > 0 && <span className="text-t2">{t('albumsMore', { count: albumsHidden })}</span>}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-t2 text-xs font-semibold tracking-wide uppercase">{t('sources')}</dt>
                <dd>{picture.sources.map((source) => ts(['takeout', 'google-photos-zip', 'loose'].includes(source) ? source : 'other')).join(', ')}</dd>
              </div>
            </dl>
            <section aria-labelledby="detail-people" className="flex flex-col gap-2">
              <h2 id="detail-people" tabIndex={-1} className="text-t2 text-xs font-semibold tracking-wide uppercase outline-none">
                {t('assignedTo')}
              </h2>
              {picture.assignedProfileIds.length === 0 && <p className="text-t2">{t('assignedNone')}</p>}
              <ul className="flex flex-col gap-2" data-testid="detail-people">
                {picture.assignedProfileIds.map((id, index) => {
                  const name = safeName(names.get(id) ?? '', NAME_IN_ROW) || t('someone');
                  return (
                    <li key={id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 break-words">
                        <bdi>{name}</bdi>
                      </span>
                      <PillButton
                        variant="outlined"
                        aria-label={t('unassignLabel', { name })}
                        aria-disabled={working || undefined}
                        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        onClick={async () => {
                          if (working) return;
                          const sha = picture.sha256;
                          const here = index;
                          const ok = await onUnassign(sha, id);
                          setFailed(!ok);
                          if (ok) settleFocus(sha, here);
                        }}
                      >
                        {t('unassign')}
                      </PillButton>
                    </li>
                  );
                })}
              </ul>
              {failed && (
                <p role="alert" className="text-destructive">
                  {t('unassignFailed')}
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </dialog>
  );
}
