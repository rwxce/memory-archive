'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { queryTokens } from '@/lib/domain/search-query';
import type { SearchResult } from '@/lib/domain/library';
import { searchMessages, type SearchScope } from '@/lib/usecases/search';
import { useLibraryInternals } from './use-library';

/** How many results one step reads and shows. */
export const SEARCH_PAGE = 50;
/** How long typing must pause before a search starts (the backend can take a second on common words). */
export const SEARCH_DEBOUNCE_MS = 250;
/** Fewest letters and digits worth searching for. */
export const SEARCH_MIN_CHARS = 2;

/** Whether `query` has enough to search for. */
export const isSearchable = (query: string) => queryTokens(query).join('').length >= SEARCH_MIN_CHARS;

/**
 * The text in the field and the query that is acted on: typing moves the query only after a pause
 * (`SEARCH_DEBOUNCE_MS`), `commit` (Enter) moves it at once. The query is trimmed.
 */
export function useSearchInput(initial: string): { input: string; setInput(value: string): void; query: string; commit(): void } {
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial.trim());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const commit = useCallback(() => setQuery(input.trim()), [input]);
  return { input, setInput, query, commit };
}

export type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  /** `refreshing`: a newer search is running and these are the previous results. */
  | { status: 'ready'; items: SearchResult[]; hasMore: boolean; loadingMore: boolean; moreFailed: boolean; refreshing: boolean }
  | { status: 'unavailable' }
  | { status: 'error' };

type Settled = Exclude<SearchState, { status: 'idle' } | { status: 'searching' }> | { status: 'searching' };

const scopeKeyOf = (scope: SearchScope) => (!scope ? 'all' : 'profileId' in scope ? `p:${scope.profileId}` : `c:${scope.conversationId}`);
const keyOf = (item: SearchResult) => `${item.conversationId}:${item.id}`;

/**
 * The results of `query` in `scope`, newest first, `SEARCH_PAGE` at a time. Nothing runs while
 * `enabled` is false (the index is not ready) or the query is too short. Only the latest request
 * counts: an answer that arrives after the query or scope changed is dropped. While a newer search
 * runs the previous results stay (marked `refreshing`) so the page does not jump. `loadMore` reads
 * from the number already shown. Errors: `unavailable` (the index cannot be opened) or `error`
 * (`retry`).
 */
export function useSearch(scope: SearchScope, query: string, enabled: boolean): { state: SearchState; loadMore(): void; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const scopeKey = scopeKeyOf(scope);
  const active = !!deps && enabled && isSearchable(query);
  const runKey = `${scopeKey}|${query}|${attempt}`;
  const [result, setResult] = useState<{ key: string; scopeKey: string; state: Settled }>({ key: '', scopeKey: '', state: { status: 'searching' } });
  const token = useRef(0);
  const busy = useRef(false);
  const latest = useRef({ result, runKey });
  latest.current = { result, runKey };
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    if (!deps || !active) return;
    const mine = ++token.current;
    busy.current = false;
    const settle = (state: Settled) => token.current === mine && setResult({ key: runKey, scopeKey, state });
    searchMessages(deps, scopeRef.current, query, 0, SEARCH_PAGE).then(
      (items) => settle({ status: 'ready', items, hasMore: items.length === SEARCH_PAGE, loadingMore: false, moreFailed: false, refreshing: false }),
      (error) => settle({ status: (error as { code?: string }).code === 'unavailable' ? 'unavailable' : 'error' }),
    );
    return () => {
      token.current++;
    };
  }, [deps, active, runKey, scopeKey, query]);

  const loadMore = useCallback(() => {
    const { result: shown, runKey: key } = latest.current;
    if (!deps || busy.current || shown.key !== key || shown.state.status !== 'ready' || !shown.state.hasMore) return;
    const { items } = shown.state;
    const mine = token.current;
    busy.current = true;
    setResult({ ...shown, state: { ...shown.state, loadingMore: true, moreFailed: false } });
    searchMessages(deps, scopeRef.current, query, items.length, SEARCH_PAGE).then(
      (page) => {
        busy.current = false;
        if (token.current !== mine) return;
        setResult((now) => {
          if (now.key !== key || now.state.status !== 'ready') return now;
          const seen = new Set(now.state.items.map(keyOf));
          const fresh = page.filter((item) => !seen.has(keyOf(item)));
          return { ...now, state: { ...now.state, items: [...now.state.items, ...fresh], hasMore: page.length === SEARCH_PAGE, loadingMore: false } };
        });
      },
      () => {
        busy.current = false;
        if (token.current !== mine) return;
        setResult((now) => (now.key === key && now.state.status === 'ready' ? { ...now, state: { ...now.state, loadingMore: false, moreFailed: true } } : now));
      },
    );
  }, [deps, query]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let state: SearchState;
  if (!active) state = { status: 'idle' };
  else if (result.key === runKey) state = result.state;
  else if (result.state.status === 'ready' && result.scopeKey === scopeKey) state = { ...result.state, refreshing: true, loadingMore: false };
  else state = { status: 'searching' };
  return { state, loadMore, retry };
}
