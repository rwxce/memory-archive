'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { PersonMediaItem } from '@/lib/domain/library';
import { setFavorite } from '@/lib/usecases/favorites';
import { useLibraryDeps } from './use-library';

/**
 * The star on a gallery item. `toggle(item)` flips the mark at once in the gallery's list (`mark`),
 * writes it, and puts the old mark back if the write fails (`onFailed` says so, calmly). While a
 * write for an item is running, further taps on it are ignored, so the list and the stored mark
 * cannot drift apart.
 */
export function useMediaFavoriteToggle(mark: (item: PersonMediaItem, favorite: boolean) => void, onFailed: () => void): (item: PersonMediaItem) => void {
  const deps = useLibraryDeps();
  const running = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return useCallback(
    (item) => {
      if (!deps) return;
      const key = `${item.conversationId}:${item.id}`;
      if (running.current.has(key)) return;
      const next = !item.isFavorite;
      running.current.add(key);
      mark(item, next);
      setFavorite(deps, item.conversationId, item.id, next).then(
        () => {
          running.current.delete(key);
        },
        () => {
          running.current.delete(key);
          mark(item, !next);
          if (alive.current) onFailed();
        },
      );
    },
    [deps, mark, onFailed],
  );
}
