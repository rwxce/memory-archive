'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HIGHLIGHT_CATEGORIES, type HighlightCategory, type HighlightItem } from '@/lib/domain/highlights';
import { isUuid } from '@/lib/domain/library';
import { countHighlights, countHighlightsByCategory, deleteHighlight, listHighlights } from '@/lib/usecases/highlights';
import { useLibraryInternals } from './use-library';

/** How many highlights one step reads and shows. */
export const PERSON_HIGHLIGHTS_PAGE = 50;

export type HighlightCounts = Record<HighlightCategory, number>;

export type PersonHighlightCountsState = { status: 'loading' } | { status: 'ready'; counts: HighlightCounts; total: number } | { status: 'error' };

/**
 * How many highlights a person has in each category (for the filter chips and group headings).
 * `reload` reads them again without going back to `loading` (after a delete or an import).
 */
export function usePersonHighlightCounts(profileId: string | null): { state: PersonHighlightCountsState; retry(): void; reload(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ id: string | null; state: PersonHighlightCountsState }>({ id: null, state: { status: 'loading' } });

  useEffect(() => {
    if (!deps || !isUuid(profileId)) return;
    let alive = true;
    countHighlightsByCategory(deps, { profileId }).then(
      (counts) => alive && setResult({ id: profileId, state: { status: 'ready', counts, total: HIGHLIGHT_CATEGORIES.reduce((sum, c) => sum + counts[c], 0) } }),
      () => alive && setResult({ id: profileId, state: { status: 'error' } }),
    );
    return () => {
      alive = false;
    };
  }, [deps, profileId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.id === profileId ? result.state : { status: 'loading' }, retry: reload, reload };
}

export type PersonHighlightsState =
  | { status: 'loading' }
  | { status: 'ready'; items: HighlightItem[]; total: number; loadingMore: boolean; moreFailed: boolean }
  | { status: 'error' };

/**
 * A person's highlights of one category, in the order of their earliest message, `PERSON_HIGHLIGHTS_PAGE`
 * at a time. A failed first read is `error` (`retry`); a failed later page keeps what is shown and
 * sets `moreFailed`. `revision` changes when the set changed outside this list (an import): the
 * list is read again from the start. `remove` deletes one highlight and takes it off the list in
 * place (`true`), or reports that it could not be deleted (`false`) and changes nothing.
 */
export function usePersonHighlights(
  profileId: string | null,
  category: HighlightCategory,
  revision = 0,
): {
  state: PersonHighlightsState;
  loadMore(): void;
  retry(): void;
  remove(item: HighlightItem): Promise<boolean>;
} {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const runKey = `${profileId}|${category}|${revision}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: PersonHighlightsState }>({ key: '', state: { status: 'loading' } });
  const busy = useRef(false);
  const latest = useRef({ key: '', result });
  latest.current = { key: latest.current.key, result };

  useEffect(() => {
    if (!deps || !isUuid(profileId)) return;
    let alive = true;
    latest.current.key = runKey;
    busy.current = false;
    const filter = { scope: { profileId }, category };
    Promise.all([countHighlights(deps, filter), listHighlights(deps, filter, 0, PERSON_HIGHLIGHTS_PAGE)]).then(
      ([total, items]) => alive && setResult({ key: runKey, state: { status: 'ready', items, total, loadingMore: false, moreFailed: false } }),
      () => alive && setResult({ key: runKey, state: { status: 'error' } }),
    );
    return () => {
      alive = false;
    };
  }, [deps, profileId, category, runKey]);

  const loadMore = useCallback(() => {
    const shown = latest.current.result;
    if (!deps || busy.current || shown.key !== latest.current.key || shown.state.status !== 'ready') return;
    const { items, total } = shown.state;
    if (items.length >= total || !isUuid(profileId)) return;
    const mine = latest.current.key;
    busy.current = true;
    setResult({ key: mine, state: { ...shown.state, loadingMore: true, moreFailed: false } });
    listHighlights(deps, { scope: { profileId }, category }, items.length, PERSON_HIGHLIGHTS_PAGE).then(
      (page) => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, items: [...now.state.items, ...page], loadingMore: false } } : now));
      },
      () => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, loadingMore: false, moreFailed: true } } : now));
      },
    );
  }, [deps, profileId, category]);

  const remove = useCallback(
    async (item: HighlightItem): Promise<boolean> => {
      if (!deps) return false;
      const mine = latest.current.key;
      try {
        await deleteHighlight(deps, item.conversationId, item.id);
      } catch {
        return false;
      }
      setResult((now) => {
        if (now.key !== mine || now.state.status !== 'ready') return now;
        const items = now.state.items.filter((i) => !(i.id === item.id && i.conversationId === item.conversationId));
        return { key: mine, state: { ...now.state, items, total: Math.max(0, now.state.total - (items.length < now.state.items.length ? 1 : 0)) } };
      });
      return true;
    },
    [deps],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === runKey ? result.state : { status: 'loading' }, loadMore, retry, remove };
}

/** The list's own key for a highlight: ids are only unique within a conversation. */
export const highlightKey = (item: HighlightItem): string => `${item.conversationId}:${item.id}`;
