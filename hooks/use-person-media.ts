'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUuid, type MediaMessageType, type PersonMediaItem } from '@/lib/domain/library';
import { countPersonMedia, listPersonMedia } from '@/lib/usecases/person-media';
import { useLibraryInternals } from './use-library';

/** How many items one step reads and shows. */
export const PERSON_MEDIA_PAGE = 50;

export type PersonMediaState =
  | { status: 'loading' }
  | { status: 'ready'; items: PersonMediaItem[]; total: number; loadingMore: boolean; moreFailed: boolean }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * A person's media of the asked `kinds` (voice messages, later photos and videos) across all their
 * conversations, oldest first, `PERSON_MEDIA_PAGE` at a time: the first page and the total when the
 * screen opens, more on `loadMore`. Only the rows (no file bytes) are read here. A missing, malformed
 * or unknown id is `not-found`; a failed first read is `error` (`retry`); a failed later page keeps
 * what is shown and sets `moreFailed`.
 */
export function usePersonMedia(
  profileId: string | null,
  kinds: readonly MediaMessageType[],
): { state: PersonMediaState; loadMore(): void; retry(): void; mark(item: PersonMediaItem, favorite: boolean): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const kindsKey = kinds.join(',');
  const key = `${profileId}|${kindsKey}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; state: PersonMediaState }>({ key: '', state: { status: 'loading' } });
  const current = useRef({ key: '' });
  const busy = useRef(false);
  const latest = useRef(result);
  latest.current = result;
  const runKey = `${key}|${attempt}`;

  useEffect(() => {
    if (!deps) return;
    const list = kindsKey.split(',') as MediaMessageType[];
    let alive = true;
    current.current = { key: runKey };
    busy.current = false;
    const settle = (state: PersonMediaState) => alive && setResult({ key: runKey, state });
    (async () => {
      if (!isUuid(profileId)) return settle({ status: 'not-found' });
      try {
        const [total, items] = await Promise.all([countPersonMedia(deps, profileId, list), listPersonMedia(deps, profileId, list, 0, PERSON_MEDIA_PAGE)]);
        settle({ status: 'ready', items, total, loadingMore: false, moreFailed: false });
      } catch (error) {
        const code = (error as { code?: string }).code;
        settle({ status: code === 'not-found' || code === 'invalid' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, profileId, kindsKey, runKey, attempt]);

  const loadMore = useCallback(() => {
    const shown = latest.current;
    if (!deps || busy.current || shown.key !== current.current.key || shown.state.status !== 'ready') return;
    const { items, total } = shown.state;
    if (items.length >= total || !isUuid(profileId)) return;
    const mine = current.current.key;
    const list = kindsKey.split(',') as MediaMessageType[];
    busy.current = true;
    setResult({ key: mine, state: { ...shown.state, loadingMore: true, moreFailed: false } });
    listPersonMedia(deps, profileId, list, items.length, PERSON_MEDIA_PAGE).then(
      (page) => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, items: [...now.state.items, ...page], loadingMore: false } } : now));
      },
      () => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, loadingMore: false, moreFailed: true } } : now));
      },
    );
  }, [deps, profileId, kindsKey]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Flips the star of one loaded item in place (the optimistic step of `useMediaFavoriteToggle`).
  const mark = useCallback((target: PersonMediaItem, favorite: boolean) => {
    setResult((now) => {
      if (now.state.status !== 'ready') return now;
      const items = now.state.items.map((item) => (item.id === target.id && item.conversationId === target.conversationId ? { ...item, isFavorite: favorite } : item));
      return { key: now.key, state: { ...now.state, items } };
    });
  }, []);
  return { state: deps && result.key === runKey ? result.state : { status: 'loading' }, loadMore, retry, mark };
}
