'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildSearchIndex, getSearchStatus } from '@/lib/usecases/search';
import { useLibraryInternals } from './use-library';

export type SearchIndexState =
  | { status: 'checking' }
  | { status: 'ready' }
  /** `reason` is why it is being built: never built (first use, or after an undo) or out of date. */
  | { status: 'building'; reason: 'not-built' | 'stale'; done: number; total: number }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error' };

/**
 * Brings the search index up to date when the search screen opens and reports the progress. `cancel`
 * stops it (what was done is kept); `start` begins again (after a cancel or an error). Leaving the
 * screen stops the work. Nothing here reads message text.
 */
export function useSearchIndex(): { state: SearchIndexState; start(): void; cancel(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<SearchIndexState>({ status: 'checking' });
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);

  const start = useCallback(async () => {
    if (!deps) return;
    const mine = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const live = () => generation.current === mine;
    try {
      const status = await getSearchStatus(deps);
      if (!live()) return;
      if (status.state === 'ready') return setState({ status: 'ready' });
      const reason = status.state;
      setState({ status: 'building', reason, done: 0, total: status.total });
      await buildSearchIndex(deps, {
        signal: abort.signal,
        onProgress: ({ done, total }) => live() && setState({ status: 'building', reason, done, total }),
      });
      if (live()) setState({ status: 'ready' });
    } catch (error) {
      if (!live()) return;
      if (abort.signal.aborted) setState({ status: 'cancelled' });
      else setState({ status: (error as { code?: string }).code === 'unavailable' ? 'unavailable' : 'error' });
    }
  }, [deps]);

  useEffect(() => {
    void start();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [start]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  return { state: deps ? state : { status: 'checking' }, start: useCallback(() => void start(), [start]), cancel };
}
