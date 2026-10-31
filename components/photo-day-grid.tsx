'use client';

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { PhotoSelection } from '@/hooks/use-photo-selection';
import type { PhotoPicture } from '@/lib/domain/photo';
import type { PhotoDay } from './photo-days';
import { PhotoTile } from './photo-tile';

interface Props {
  days: readonly PhotoDay[];
  selection: PhotoSelection;
  selecting: boolean;
  onSelecting(on: boolean): void;
  onOpen(picture: PhotoPicture): void;
  /** Some pictures were left out of a choice because the most one assignment takes is reached. */
  onCap(): void;
}

/**
 * The pictures grouped by day: each day a heading with "select this day" and an `option` list (multi-select).
 * One tile is in the tab order; arrows, Home and End move between tiles across days, Shift+arrows extend the
 * choice, Ctrl/Cmd+A chooses everything loaded. Escape does NOT clear the choice (a stray key must not lose a long
 * selection): "Clear" in the action bar does. The choice itself lives in `selection`.
 *
 * The tiles are memoized and every callback handed to them is stable (they read the latest `selection` through a ref),
 * so choosing one picture re-renders that tile, not the whole loaded list.
 */
export function PhotoDayGrid({ days, selection, selecting, onSelecting, onOpen, onCap }: Props) {
  const t = useTranslations('photos.select');
  const format = useFormatter();
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const latest = useRef(selection);
  latest.current = selection;

  const flat = useMemo(() => days.flatMap((day) => day.pictures), [days]);
  const index = useMemo(() => new Map(flat.map((p, i) => [p.sha256, i])), [flat]);
  const tabbable = focused !== null && index.has(focused) ? focused : (flat[0]?.sha256 ?? null);

  // A day shown twice (pictures of two zones interleave) is two groups: "Select day" then acts on the group it sits in.
  const repeated = useMemo(() => {
    const seen = new Set<string>();
    const again = new Set<string>();
    for (const day of days) {
      const id = day.day ?? 'undated';
      if (seen.has(id)) again.add(id);
      seen.add(id);
    }
    return again;
  }, [days]);

  const add = useCallback(
    (pictures: readonly PhotoPicture[], on: boolean) => {
      if (latest.current.setMany(pictures, on).capped) onCap();
    },
    [onCap],
  );

  const choose = useCallback(
    (picture: PhotoPicture, { shift }: { shift: boolean; toggle: boolean }) => {
      onSelecting(true);
      const from = latest.current.anchor.current === null ? undefined : index.get(latest.current.anchor.current);
      const to = index.get(picture.sha256);
      if (shift && from !== undefined && to !== undefined) {
        add(flat.slice(Math.min(from, to), Math.max(from, to) + 1), true);
        return;
      }
      if (latest.current.toggle(picture) === 'cap') onCap();
    },
    [index, flat, add, onCap, onSelecting],
  );

  const longPress = useCallback(
    (picture: PhotoPicture) => {
      onSelecting(true);
      if (!latest.current.has(picture.sha256) && latest.current.toggle(picture) === 'cap') onCap();
    },
    [onSelecting, onCap],
  );

  const moveTo = (position: number, extend: boolean) => {
    const picture = flat[Math.max(0, Math.min(flat.length - 1, position))];
    if (!picture) return;
    if (extend) {
      onSelecting(true);
      const from = selection.anchor.current === null ? undefined : index.get(selection.anchor.current);
      const start = from ?? index.get(focused ?? picture.sha256) ?? 0;
      add(flat.slice(Math.min(start, position), Math.max(start, position) + 1), true);
      if (from === undefined) selection.anchor.current = flat[start]?.sha256 ?? null;
    }
    setFocused(picture.sha256);
    root.current?.querySelector<HTMLElement>(`[data-photo="${picture.sha256}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-photo]');
    if (!tile) return;
    const here = index.get(tile.dataset.photo ?? '') ?? 0;
    const rtl = getComputedStyle(tile).direction === 'rtl';
    const columns = Math.max(1, getComputedStyle(tile.parentElement!).gridTemplateColumns.split(' ').filter(Boolean).length);
    const step = ({ ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: columns, ArrowUp: -columns } as Record<string, number>)[event.key];
    if (step !== undefined) {
      event.preventDefault();
      moveTo(here + step, event.shiftKey);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveTo(event.key === 'Home' ? 0 : flat.length - 1, event.shiftKey);
    } else if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSelecting(true);
      add(flat, true);
    }
  };

  return (
    <div ref={root} onKeyDown={onKeyDown} onFocus={(event) => setFocused((event.target as HTMLElement).dataset.photo ?? focused)} className="flex flex-col gap-5">
      {days.map((day) => {
        const chosen = day.pictures.filter((p) => selection.has(p.sha256)).length;
        const all = chosen === day.pictures.length;
        const title = day.day === null ? t('day.undated') : format.dateTime(new Date(`${day.day}T00:00:00Z`), { dateStyle: 'full', timeZone: 'UTC' });
        return (
          <section key={day.key} aria-labelledby={`day-${day.key}`} data-day={day.day ?? 'undated'} className="flex flex-col gap-2">
            <div className="bg-bg lg:bg-sf sticky top-0 z-10 flex min-h-11 items-center justify-between gap-3 py-1">
              <h3 id={`day-${day.key}`} className="min-w-0 text-base font-semibold break-words">
                {title}
                {day.allEstimated && day.day !== null && <span className="text-t2 ms-2 text-sm font-normal">({t('day.estimated')})</span>}
                <span className="text-t2 ms-2 text-sm font-normal">{day.pictures.length}</span>
              </h3>
              <button
                type="button"
                aria-pressed={all}
                aria-label={t(`day.${all ? 'unselect' : 'select'}${repeated.has(day.day ?? 'undated') ? 'Part' : ''}Label`, { day: title, count: day.pictures.length })}
                onClick={() => {
                  onSelecting(true);
                  add(day.pictures, !all);
                }}
                className="text-ac-tx focus-visible:ring-ring/50 min-h-11 shrink-0 rounded-full px-3 text-sm font-medium underline outline-none focus-visible:ring-[3px]"
              >
                {t(all ? 'day.unselect' : 'day.select')}
              </button>
            </div>
            <div role="listbox" aria-multiselectable="true" aria-labelledby={`day-${day.key}`} className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
              {day.pictures.map((picture) => (
                <PhotoTile
                  key={picture.sha256}
                  picture={picture}
                  selected={selection.has(picture.sha256)}
                  tabbable={picture.sha256 === tabbable}
                  selecting={selecting}
                  onSelect={choose}
                  onOpen={onOpen}
                  onLongPress={longPress}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
