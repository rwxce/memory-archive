'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { PHOTO_ASSIGN_MAX, type PhotoPicture } from '@/lib/domain/photo';

export interface PhotoSelection {
  count: number;
  /** The chosen pictures as they were when chosen, in the order they were chosen. */
  pictures: PhotoPicture[];
  has(sha256: string): boolean;
  toggle(picture: PhotoPicture): 'ok' | 'cap';
  /** Adds (or removes) these; adds as many as fit under the cap. `capped` when some were left out. */
  setMany(pictures: readonly PhotoPicture[], on: boolean): { capped: boolean };
  /** The last picture chosen or unchosen on its own: where a range starts. */
  anchor: React.RefObject<string | null>;
  clear(): void;
  /** Drops pictures (they left the collection or the list). */
  drop(sha256s: ReadonlySet<string>): void;
}

/**
 * The chosen pictures. They live here, not in the grid, so a choice survives paging, filters and the detail view.
 * At most `PHOTO_ASSIGN_MAX` (the most one assignment takes).
 */
export function usePhotoSelection(max = PHOTO_ASSIGN_MAX): PhotoSelection {
  const [chosen, setChosen] = useState<ReadonlyMap<string, PhotoPicture>>(new Map());
  const now = useRef(chosen);
  now.current = chosen;
  const anchor = useRef<string | null>(null);

  const commit = useCallback((next: Map<string, PhotoPicture>) => {
    now.current = next;
    setChosen(next);
  }, []);

  const toggle = useCallback(
    (picture: PhotoPicture) => {
      const next = new Map(now.current);
      anchor.current = picture.sha256;
      if (next.delete(picture.sha256)) {
        commit(next);
        return 'ok' as const;
      }
      if (next.size >= max) return 'cap' as const;
      next.set(picture.sha256, picture);
      commit(next);
      return 'ok' as const;
    },
    [commit, max],
  );

  const setMany = useCallback(
    (pictures: readonly PhotoPicture[], on: boolean) => {
      const next = new Map(now.current);
      let capped = false;
      for (const picture of pictures) {
        if (!on) next.delete(picture.sha256);
        else if (!next.has(picture.sha256)) {
          if (next.size >= max) capped = true;
          else next.set(picture.sha256, picture);
        }
      }
      commit(next);
      return { capped };
    },
    [commit, max],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    commit(new Map());
  }, [commit]);

  const drop = useCallback(
    (sha256s: ReadonlySet<string>) => {
      const next = new Map([...now.current].filter(([sha]) => !sha256s.has(sha)));
      if (next.size !== now.current.size) commit(next);
    },
    [commit],
  );

  return useMemo(
    () => ({ count: chosen.size, pictures: [...chosen.values()], has: (sha) => chosen.has(sha), toggle, setMany, anchor, clear, drop }),
    [chosen, toggle, setMany, clear, drop],
  );
}
