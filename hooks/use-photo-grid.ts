'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhotoCounts, PhotoCursor, PhotoPicture, PhotoScope } from '@/lib/domain/photo';
import { countPhotoPictures, listPhotoPictures } from '@/lib/usecases/photo-assign';
import { useLibraryInternals } from './use-library';

export const PHOTO_FILTERS = ['unassigned', 'assigned', 'all'] as const;
export type PhotoFilter = (typeof PHOTO_FILTERS)[number];

/** Pictures read per page. */
export const PHOTO_PAGE_SIZE = 120;

export const scopeOf = (filter: PhotoFilter): PhotoScope => ({ show: filter });

export interface PhotoGrid {
  status: 'loading' | 'error' | 'ready';
  pictures: PhotoPicture[];
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  counts: PhotoCounts | undefined;
  loadMore(): Promise<void>;
  /** Reads the first page again (after an undo): the list is rebuilt from the database. */
  reload(): Promise<void>;
  /** Changes what the loaded pictures say about their profiles, and drops those that no longer belong to the filter. */
  patch(update: (picture: PhotoPicture) => PhotoPicture): void;
  /** Counts again (after an assignment). */
  recount(): Promise<void>;
}

/**
 * The pictures of one filter, paged by cursor. A newer request (another filter, a reload) makes an older
 * answer worthless; nothing is read before the library is open. `patch` keeps the list honest after a local
 * change without re-reading it: a picture that no longer matches the filter leaves.
 */
export function usePhotoGrid(filter: PhotoFilter): PhotoGrid {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [status, setStatus] = useState<PhotoGrid['status']>('loading');
  const [pictures, setPictures] = useState<PhotoPicture[]>([]);
  const [cursor, setCursor] = useState<PhotoCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [counts, setCounts] = useState<PhotoCounts>();
  const latest = useRef(0);
  const busy = useRef(false);
  const cursorRef = useRef<PhotoCursor | null>(null);
  cursorRef.current = cursor;

  const recount = useCallback(async () => {
    if (!deps) return;
    try {
      setCounts(await countPhotoPictures(deps));
    } catch {
      // The counts are a convenience; the list is what matters.
    }
  }, [deps]);

  const reload = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    busy.current = false;
    setStatus('loading');
    setLoadingMore(false);
    setMoreFailed(false);
    try {
      const page = await listPhotoPictures(deps, { scope: scopeOf(filter), limit: PHOTO_PAGE_SIZE });
      if (mine !== latest.current) return;
      setPictures(page.pictures);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch {
      if (mine === latest.current) setStatus('error');
    }
    void recount();
  }, [deps, filter, recount]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current++;
    };
  }, [reload]);

  const loadMore = useCallback(async () => {
    const next = cursorRef.current;
    if (!deps || !next || busy.current) return;
    busy.current = true;
    const mine = latest.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await listPhotoPictures(deps, { scope: scopeOf(filter), cursor: next, limit: PHOTO_PAGE_SIZE });
      if (mine !== latest.current) return;
      setPictures((now) => {
        const have = new Set(now.map((p) => p.sha256));
        return [...now, ...page.pictures.filter((p) => !have.has(p.sha256))];
      });
      setCursor(page.nextCursor);
    } catch {
      if (mine === latest.current) setMoreFailed(true);
    } finally {
      if (mine === latest.current) {
        busy.current = false;
        setLoadingMore(false);
      }
    }
  }, [deps, filter]);

  const patch = useCallback(
    (update: (picture: PhotoPicture) => PhotoPicture) => {
      const matches = (p: PhotoPicture) => filter === 'all' || (filter === 'assigned' ? p.assignedProfileIds.length > 0 : p.assignedProfileIds.length === 0);
      setPictures((now) => now.map(update).filter(matches));
    },
    [filter],
  );

  return { status: deps ? status : 'loading', pictures, hasMore: cursor !== null, loadingMore, moreFailed, counts, loadMore, reload, patch, recount };
}
