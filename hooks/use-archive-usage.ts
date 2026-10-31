'use client';

import { useCallback, useEffect, useState } from 'react';
import { getArchiveUsage, type ArchiveUsage } from '@/lib/usecases/archive-health';
import { useLibraryInternals } from './use-library';

export type ArchiveUsageState = { status: 'loading' } | { status: 'ready'; usage: ArchiveUsage } | { status: 'error' };

/** What the archive stores (counts, bytes per kind) and the device's quota; `reload` reads it again (after a restore). */
export function useArchiveUsage(): { state: ArchiveUsageState; reload: () => void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<ArchiveUsageState>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    getArchiveUsage(deps).then(
      (usage) => alive && setState({ status: 'ready', usage }),
      () => alive && setState({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state, reload };
}
