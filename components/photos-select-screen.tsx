'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LibraryNotice } from '@/components/library-notice';
import { PageTitle } from '@/components/page-title';
import { PhotoActionBar, PhotoAssignResult } from '@/components/photo-select-bar';
import { PhotoAssignDialog } from '@/components/photo-assign-dialog';
import { PhotoDayGrid } from '@/components/photo-day-grid';
import { groupByDay } from '@/components/photo-days';
import { PhotoDetailDialog } from '@/components/photo-detail-dialog';
import { PhotoSelectToolbar } from '@/components/photo-select-toolbar';
import { PillButton } from '@/components/pill-button';
import { LoadingNote } from '@/components/screen-states';
import { Shell } from '@/components/screen-shell';
import { ShowMore } from '@/components/show-more';
import { type AssignOutcome, usePhotoAssign } from '@/hooks/use-photo-assign';
import { usePhotoGrid, type PhotoFilter } from '@/hooks/use-photo-grid';
import { usePhotoMonths } from '@/hooks/use-photo-months';
import { usePhotoSelection } from '@/hooks/use-photo-selection';
import { useLibrary } from '@/hooks/use-library';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { usePeople } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import { PHOTO_ASSIGN_MAX } from '@/lib/domain/photo';

/**
 * Choose pictures for people: the collection by day, a choice that survives paging, and an explicit
 * "Assign to…" that names the pictures and the people before anything is written. Nothing is assigned by date,
 * album or name; only the pictures the person chose. Opens the library itself (all of it needs it).
 */
export function PhotosSelectScreen() {
  const { state, retry } = useLibrary();
  const tn = useTranslations('photos');
  if (state.status !== 'ready') {
    return (
      <Shell back={{ href: '/photos', label: tn('title') }}>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <SelectContent />;
}

const SELECTION_SAY_MS = 600;
/** Pages a jump to a month may load before it stops (40 x 120 = 4,800 pictures): the list is not virtualized. */
export const JUMP_PAGES_MAX = 40;
/** Turning Select off lets a choice go only up to this many pictures; a bigger one is kept (and said so). */
export const SELECTION_KEEP_FROM = 20;

function SelectContent() {
  const t = useTranslations('photos.select');
  const tn = useTranslations('photos');
  const [filter, setFilter] = useState<PhotoFilter>('unassigned');
  const grid = usePhotoGrid(filter);
  const selection = usePhotoSelection();
  const people = usePeople();
  const actions = usePhotoAssign();
  const [monthsBump, setMonthsBump] = useState(0);
  // Months are read again whenever the pictures of a filter may have changed: the counts moved, or we assigned / took back / took out.
  const months = usePhotoMonths(filter, grid.counts ? `${grid.counts.pictures}:${grid.counts.unassigned}:${monthsBump}` : undefined);
  const [selecting, setSelecting] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AssignOutcome | null>(null);
  const [notice, setNotice] = useState('');
  const [said, setSaid] = useState('');
  const [jump, setJump] = useState<string | null>(null);
  const [undoFailed, setUndoFailed] = useState(false);
  const jumpPages = useRef(0);
  const result = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const near = useNearViewport(sentinel, grid.hasMore);

  const days = useMemo(() => groupByDay(grid.pictures), [grid.pictures]);
  const names = useMemo(() => new Map(people.status === 'ready' ? [...people.people.active, ...people.people.archived].map((p) => [p.id, p.displayName]) : []), [people]);
  const { loadMore, hasMore, loadingMore, moreFailed } = grid;

  // Reaching the end of what is loaded reads the next page (the button below does the same).
  useEffect(() => {
    if (near && hasMore && !loadingMore && !moreFailed) void loadMore();
  }, [near, hasMore, loadingMore, moreFailed, loadMore, grid.pictures.length]);

  // The choice is said once it settles, not at every tap.
  useEffect(() => {
    const id = setTimeout(() => setSaid(selection.count > 0 ? t('count', { count: selection.count }) : ''), SELECTION_SAY_MS);
    return () => clearTimeout(id);
  }, [selection.count, t]);

  // A result appeared: focus goes to it, so it is read and the keyboard stays near where it was.
  useEffect(() => {
    if (outcome) result.current?.focus();
  }, [outcome]);

  // A jump to a month: load pages until the day is there, then bring it into view. It always ends: found, the list is
  // over (the month is not in it), a page cannot be read, or JUMP_PAGES_MAX pages were loaded.
  useEffect(() => {
    if (jump === null) return;
    const stop = (message: string) => {
      jumpPages.current = 0;
      setJump(null);
      setNotice(message);
    };
    const section = document.querySelector<HTMLElement>(jump === 'undated' ? '[data-day="undated"]' : `[data-day^="${jump}"]`);
    if (section) {
      jumpPages.current = 0;
      section.scrollIntoView({ block: 'start' });
      section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
      setJump(null);
    } else if (moreFailed) stop(t('jump.failed'));
    else if (loadingMore) return;
    else if (!hasMore) stop(t('jump.empty'));
    else if (jumpPages.current >= JUMP_PAGES_MAX) stop(t('jump.stopped'));
    else {
      jumpPages.current++;
      void loadMore();
    }
  }, [jump, days, hasMore, loadingMore, moreFailed, loadMore, t]);

  const changeFilter = (next: PhotoFilter) => {
    setFilter(next);
    setJump(null);
    jumpPages.current = 0;
    // A choice belongs to what was on screen; carrying it into another list would assign pictures no longer in view.
    setNotice(selection.count > 0 ? t('selectionCleared') : '');
    selection.clear();
  };

  const capped = useCallback(() => setNotice(t('cap', { max: PHOTO_ASSIGN_MAX })), [t]);
  const setSelectingMode = useCallback(
    (on: boolean) => {
      setSelecting(on);
      if (on) return;
      // A short choice is let go with Select; a long one (hours of picking) is kept, so one tap cannot lose it.
      if (selection.count > SELECTION_KEEP_FROM) setNotice(t('selectOffKept', { count: selection.count }));
      else selection.clear();
    },
    [selection, t],
  );
  const clear = () => {
    selection.clear();
    setNotice('');
  };
  const open = useCallback((p: { sha256: string }) => setDetail(p.sha256), []);

  // Walking to another picture, or closing because there is none left to show: then there is no tile to return to, so the heading gets focus.
  const walkDetail = useCallback((sha: string | null) => {
    setDetail(sha);
    if (sha === null) setTimeout(() => document.querySelector<HTMLElement>('h1')?.focus(), 0);
  }, []);

  const closeDetail = useCallback((sha: string) => {
    setDetail(null);
    // The tile gets focus back; if it left the list (taken out of the last person in "Assigned"), the list's heading does.
    setTimeout(() => (document.querySelector<HTMLElement>(`[data-photo="${sha}"]`) ?? document.querySelector<HTMLElement>('h1'))?.focus(), 0);
  }, []);

  const assign = async (profileIds: string[]) => {
    const chosen = selection.pictures;
    const done = await actions.assign(chosen, profileIds);
    setAssignOpen(false);
    setUndoFailed(false);
    setOutcome(done);
    if (done.kind === 'failed' && done.gone && done.gone.length > 0) {
      // Pictures that left the collection (another tab) would fail every retry: take them off the choice and say how many.
      selection.drop(new Set(done.gone));
      setNotice(t('gone', { count: done.gone.length }));
      void grid.reload();
    }
    if (done.kind !== 'assigned') return;
    const shas = new Set(chosen.map((p) => p.sha256));
    const leaving = filter === 'unassigned' ? grid.pictures.filter((p) => shas.has(p.sha256)).length : 0;
    grid.patch((p) => (shas.has(p.sha256) ? { ...p, assignedProfileIds: [...new Set([...p.assignedProfileIds, ...profileIds])].sort() } : p));
    selection.clear();
    setNotice(leaving > 0 ? t('left', { count: leaving }) : '');
    void grid.recount();
    setMonthsBump((n) => n + 1);
  };

  const undo = async () => {
    if (outcome?.kind !== 'assigned' || !outcome.fresh) return;
    const done = await actions.undo(outcome.fresh);
    if (done.kind === 'undone') {
      setUndoFailed(false);
      setOutcome(done);
      setNotice('');
      await grid.reload();
      setMonthsBump((n) => n + 1);
    } else {
      // It was one transaction, so nothing was half undone: the assignment stays on screen and Undo can be pressed again.
      setUndoFailed(true);
    }
  };

  const unassignOne = async (sha256: string, profileId: string) => {
    const ok = await actions.unassignOne(sha256, profileId);
    if (ok) {
      grid.patch((p) => (p.sha256 === sha256 ? { ...p, assignedProfileIds: p.assignedProfileIds.filter((id) => id !== profileId) } : p));
      void grid.recount();
      setMonthsBump((n) => n + 1);
    }
    return ok;
  };

  const empty = grid.status === 'ready' && grid.pictures.length === 0;
  return (
    <Shell focused back={{ href: '/photos', label: tn('title') }} message={notice || said}>
      <div className="flex flex-col gap-1.5">
        <PageTitle tabIndex={-1}>{t('title')}</PageTitle>
        <p className="text-t2 leading-relaxed">{t('intro')}</p>
      </div>
      <PhotoSelectToolbar filter={filter} counts={grid.counts} months={months} selecting={selecting} onFilter={changeFilter} onSelecting={setSelectingMode} onJump={setJump} />
      {outcome && <PhotoAssignResult ref={result} outcome={outcome} busy={actions.working} undoFailed={undoFailed} onUndo={() => void undo()} onClose={() => setOutcome(null)} />}
      {grid.status === 'loading' && <LoadingNote>{t('loading')}</LoadingNote>}
      {grid.status === 'error' && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>{t('failed')}</p>
          <PillButton variant="outlined" onClick={() => void grid.reload()}>
            {t('retry')}
          </PillButton>
        </div>
      )}
      {empty && (
        <div className="flex flex-col items-start gap-2" data-testid="select-empty">
          <p className="text-t2">{t(`empty.${filter}`)}</p>
          {filter === 'all' && (
            <PillButton asChild variant="ghost-link" className="px-0">
              <Link href="/photos">{t('empty.add')}</Link>
            </PillButton>
          )}
        </div>
      )}
      {grid.status === 'ready' && !empty && <PhotoDayGrid days={days} selection={selection} selecting={selecting} onSelecting={setSelecting} onOpen={open} onCap={capped} />}
      {grid.status === 'ready' && grid.hasMore && (
        <div ref={sentinel}>
          <ShowMore
            shown={grid.pictures.length}
            total={grid.pictures.length + 1}
            loading={grid.loadingMore}
            failed={grid.moreFailed}
            onMore={() => void grid.loadMore()}
            labels={{ shown: '', moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
          />
        </div>
      )}
      {selection.count > 0 && <PhotoActionBar count={selection.count} disabled={actions.working} onAssign={() => setAssignOpen(true)} onClear={clear} />}
      <PhotoAssignDialog open={assignOpen} count={selection.count} people={people} working={actions.working} onConfirm={(ids) => void assign(ids)} onCancel={() => setAssignOpen(false)} />
      <PhotoDetailDialog
        pictures={grid.pictures}
        openSha={detail}
        hasMore={grid.hasMore}
        loadingMore={grid.loadingMore}
        names={names}
        working={actions.working}
        onOpen={walkDetail}
        onClose={closeDetail}
        loadMore={() => void grid.loadMore()}
        onUnassign={unassignOne}
      />
    </Shell>
  );
}
