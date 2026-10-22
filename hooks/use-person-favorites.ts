'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUuid, type PersonTimelineMessage } from '@/lib/domain/library';
import { countFavorites, listFavorites, setFavorite } from '@/lib/usecases/favorites';
import { useLibraryInternals } from './use-library';

/** How many favorites one step reads and shows. */
export const PERSON_FAVORITES_PAGE = 50;

export type PersonFavoritesState =
  | { status: 'loading' }
  | { status: 'ready'; items: PersonTimelineMessage[]; total: number; loadingMore: boolean; moreFailed: boolean }
  | { status: 'not-found' }
  | { status: 'error' };

export type RemoveResult = 'removed' | 'failed' | 'busy';

const keyOf = (item: PersonTimelineMessage) => `${item.conversationId}:${item.id}`;

/**
 * A person's favorite messages across all their conversations, oldest first, `PERSON_FAVORITES_PAGE`
 * at a time: the first page and the total when the screen opens, more on `loadMore`. A missing,
 * malformed or unknown id is `not-found`; a failed first read is `error` (`retry`); a failed later
 * page keeps what is shown and sets `moreFailed`. `remove` unmarks one and drops it from the list
 * once it is stored (the list stays still until then); a second press on the same message while its
 * write runs is `busy`. Later pages are read from the number shown, so a removal never skips one.
 */
export function usePersonFavorites(profileId: string | null): {
  state: PersonFavoritesState;
  loadMore(): void;
  retry(): void;
  remove(item: PersonTimelineMessage): Promise<RemoveResult>;
} {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const runKey = `${profileId}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: PersonFavoritesState }>({ key: '', state: { status: 'loading' } });
  const busy = useRef(false);
  const removing = useRef(new Set<string>());
  const latest = useRef({ key: '', result });
  latest.current = { key: latest.current.key, result };

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    latest.current.key = runKey;
    busy.current = false;
    const settle = (state: PersonFavoritesState) => alive && setResult({ key: runKey, state });
    (async () => {
      if (!isUuid(profileId)) return settle({ status: 'not-found' });
      try {
        const scope = { profileId };
        const [total, items] = await Promise.all([countFavorites(deps, scope), listFavorites(deps, scope, 0, PERSON_FAVORITES_PAGE)]);
        settle({ status: 'ready', items, total, loadingMore: false, moreFailed: false });
      } catch (error) {
        const code = (error as { code?: string }).code;
        settle({ status: code === 'not-found' || code === 'invalid' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, profileId, runKey]);

  const loadMore = useCallback(() => {
    const shown = latest.current.result;
    if (!deps || busy.current || shown.key !== latest.current.key || shown.state.status !== 'ready') return;
    const { items, total } = shown.state;
    if (items.length >= total || !isUuid(profileId)) return;
    const mine = latest.current.key;
    busy.current = true;
    setResult({ key: mine, state: { ...shown.state, loadingMore: true, moreFailed: false } });
    listFavorites(deps, { profileId }, items.length, PERSON_FAVORITES_PAGE).then(
      (page) => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, items: [...now.state.items, ...page], loadingMore: false } } : now));
      },
      () => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, loadingMore: false, moreFailed: true } } : now));
      },
    );
  }, [deps, profileId]);

  const remove = useCallback(
    async (item: PersonTimelineMessage): Promise<RemoveResult> => {
      const key = keyOf(item);
      if (!deps || removing.current.has(key)) return 'busy';
      const mine = latest.current.key;
      removing.current.add(key);
      try {
        await setFavorite(deps, item.conversationId, item.id, false);
      } catch {
        removing.current.delete(key);
        return 'failed';
      }
      removing.current.delete(key);
      setResult((now) =>
        now.key === mine && now.state.status === 'ready'
          ? { key: mine, state: { ...now.state, items: now.state.items.filter((i) => keyOf(i) !== key), total: Math.max(0, now.state.total - 1) } }
          : now,
      );
      return 'removed';
    },
    [deps],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === runKey ? result.state : { status: 'loading' }, loadMore, retry, remove };
}
