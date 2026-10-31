'use client';

import { useEffect, useState } from 'react';
import type { PhotoCounts } from '@/lib/domain/photo';
import { countPhotoPictures } from '@/lib/usecases/photo-assign';
import { useLibraryInternals } from './use-library';

/** How many pictures there are and how many belong to nobody; read again when `version` changes (an import or an undo). `undefined` until known or if it cannot be read. */
export function usePhotoCounts(version: unknown): PhotoCounts | undefined {
  const { state, register } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [counts, setCounts] = useState<PhotoCounts>();
  useEffect(() => {
    if (!deps) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await countPhotoPictures(deps);
        if (alive) setCounts(next);
      } catch {
        if (alive) setCounts(undefined);
      }
    };
    void load();
    const unregister = register(load);
    return () => {
      alive = false;
      unregister();
    };
  }, [deps, register, version]);
  return counts;
}
