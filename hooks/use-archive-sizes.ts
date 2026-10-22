'use client';

import { useEffect, useState } from 'react';
import { getArchiveSizes, type ArchiveSizes } from '@/lib/usecases/device-storage';
import { useLibraryInternals } from './use-library';

/** What the archive stores, split for the Settings bar; `undefined` while loading or when the library is not open, `null` if it could not be read. */
export function useArchiveSizes(): ArchiveSizes | null | undefined {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [sizes, setSizes] = useState<ArchiveSizes | null>();
  useEffect(() => {
    if (!deps) return;
    let alive = true;
    getArchiveSizes(deps).then(
      (s) => alive && setSizes(s),
      () => alive && setSizes(null),
    );
    return () => {
      alive = false;
    };
  }, [deps]);
  return sizes;
}
