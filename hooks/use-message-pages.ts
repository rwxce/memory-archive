'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMessageWindow } from '@/lib/usecases/conversation-view';
import { MAX_PAGES, PAGE_SIZE, PageCache, pagesFor, type MessageAt } from './message-pages';
import { useLibraryInternals } from './use-library';

export interface MessagePages {
  /** The message at a position, when its page is loaded. */
  at(index: number): MessageAt | undefined;
  /** Says which rows are on screen: loads their pages and the next ones, drops the far ones. */
  request(start: number, end: number): void;
  /** Something is being read. */
  busy: boolean;
  /** A page could not be read; `retry` asks again. */
  failed: boolean;
  retry(): void;
  /** Changes whenever a page arrives or goes, so rows can re-read `at`. */
  version: number;
}

/**
 * The messages of one conversation by position, a page at a time. Pages are read through the
 * use case as the list asks for them, kept in a small cache and dropped when far from the
 * rows in view. A page that fails is remembered as failed (not retried in a loop) until `retry`.
 */
export function useMessagePages(conversationId: string, count: number, pageSize: number = PAGE_SIZE, maxPages: number = MAX_PAGES): MessagePages {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const store = useMemo(
    () => ({
      cache: new PageCache(maxPages, pageSize),
      inFlight: new Set<number>(),
      failed: new Set<number>(),
      keep: new Set<number>(),
      center: 0,
      last: { start: 0, end: 0 },
      dead: false,
    }),
    [deps, conversationId, maxPages, pageSize],
  );
  useEffect(() => {
    store.dead = false;
    return () => {
      store.dead = true;
    };
  }, [store]);

  const load = useCallback(
    (page: number) => {
      if (!deps || store.cache.has(page) || store.inFlight.has(page) || store.failed.has(page)) return;
      store.inFlight.add(page);
      // One row before the page (when there is one) tells the first row whether the day changed.
      const offset = Math.max(0, page * pageSize - 1);
      const limit = pageSize + (page > 0 ? 1 : 0);
      getMessageWindow(deps, conversationId, offset, limit).then(
        (rows) => {
          store.inFlight.delete(page);
          if (store.dead) return;
          const before = page > 0 ? (rows[0] ?? null) : null;
          store.cache.set({ index: page, messages: page > 0 ? rows.slice(1) : rows, before });
          store.cache.trim(store.center, store.keep);
          bump();
        },
        () => {
          store.inFlight.delete(page);
          if (store.dead) return;
          store.failed.add(page);
          bump();
        },
      );
    },
    [deps, conversationId, pageSize, store, bump],
  );

  const request = useCallback(
    (start: number, end: number) => {
      const wanted = pagesFor(start, end, count, pageSize);
      store.last = { start, end };
      store.keep = new Set(wanted);
      store.center = Math.floor((start + end) / 2 / pageSize);
      for (const page of wanted) load(page);
      store.cache.trim(store.center, store.keep);
    },
    [count, pageSize, store, load],
  );

  const retry = useCallback(() => {
    store.failed.clear();
    request(store.last.start, store.last.end);
    bump();
  }, [store, request, bump]);

  const at = useCallback((index: number) => store.cache.at(index), [store, version]);

  return { at, request, busy: store.inFlight.size > 0, failed: store.failed.size > 0, retry, version };
}
