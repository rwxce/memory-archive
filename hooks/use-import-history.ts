'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { historyCursorOf, listImportHistory, type ImportHistoryEntry } from '@/lib/usecases/import-history';
import { useLibraryInternals } from './use-library';

/** How many imports one page shows. */
export const HISTORY_PAGE = 20;

export type ImportHistoryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: ImportHistoryEntry[]; hasMore: boolean };

/** `stale`: nothing was read wrong; the list changed or another page is loading, so this page was dropped. */
export type LoadMoreResult = { ok: true; firstNewId?: string } | { ok: false; stale: boolean };

/** The most the database returns in one page (see `listImportBatches`). */
export const HISTORY_SERVER_CAP = 200;

export interface HistoryPaging {
  /** Entries per page. */
  page?: number;
  /** The server's page cap; a reload of more entries than this is read page by page. Tests make it small. */
  cap?: number;
}

/**
 * The import history, newest first (all of it, or only imports into the conversations kept under
 * one person), a page at a time. Reloaded when the library says something changed (an undo); the
 * reload keeps as many entries on screen as were loaded.
 */
export function useImportHistory(profileId: string | null, paging: HistoryPaging = {}): { state: ImportHistoryState; loadingMore: boolean; loadMore: () => Promise<LoadMoreResult> } {
  const { state, register } = useLibraryInternals();
  const pageSize = paging.page ?? HISTORY_PAGE;
  const cap = paging.cap ?? HISTORY_SERVER_CAP;
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [result, setResult] = useState<{ key: string | null; state: ImportHistoryState }>({ key: profileId, state: { status: 'loading' } });
  const [loadingMore, setLoadingMore] = useState(false);
  const latest = useRef(0);
  const loaded = useRef(0);
  const current = useRef<ImportHistoryEntry[]>([]);
  const busy = useRef(false);
  const filter = profileId ?? undefined;

  const load = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    // As many as were on screen, read page by page: one request never asks for more than the cap.
    const target = Math.max(pageSize, loaded.current);
    try {
      const entries: ImportHistoryEntry[] = [];
      let hasMore = true;
      while (entries.length < target) {
        const limit = Math.min(cap, target - entries.length);
        const last = entries[entries.length - 1];
        const page = await listImportHistory(deps, { profileId: filter, limit, ...(last ? { before: historyCursorOf(last) } : {}) });
        if (mine !== latest.current) return;
        entries.push(...page);
        if (page.length < limit) {
          hasMore = false;
          break;
        }
      }
      loaded.current = entries.length;
      current.current = entries;
      setResult({ key: profileId, state: { status: 'ready', entries, hasMore } });
    } catch {
      if (mine === latest.current) setResult({ key: profileId, state: { status: 'error' } });
    }
  }, [deps, filter, profileId, pageSize, cap]);

  useEffect(() => {
    loaded.current = 0;
    current.current = [];
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [load, register]);

  const loadMore = useCallback(async (): Promise<LoadMoreResult> => {
    const last = current.current[current.current.length - 1];
    if (!deps || !last || busy.current) return { ok: false, stale: true };
    busy.current = true;
    setLoadingMore(true);
    const mine = latest.current;
    try {
      const page = await listImportHistory(deps, { profileId: filter, limit: pageSize, before: historyCursorOf(last) });
      // A reload in the meantime has the newer picture; this page would repeat or skip entries.
      if (mine !== latest.current) return { ok: false, stale: true };
      const known = new Set(current.current.map((e) => e.id));
      const fresh = page.filter((e) => !known.has(e.id));
      const entries = [...current.current, ...fresh];
      loaded.current = entries.length;
      current.current = entries;
      setResult({ key: profileId, state: { status: 'ready', entries, hasMore: page.length === pageSize } });
      return { ok: true, firstNewId: fresh[0]?.id };
    } catch {
      return { ok: false, stale: false };
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [deps, filter, profileId, pageSize]);

  // A result for another filter (the address changed) is stale.
  const shown: ImportHistoryState = deps && result.key === profileId ? result.state : { status: 'loading' };
  return { state: shown, loadingMore, loadMore };
}
