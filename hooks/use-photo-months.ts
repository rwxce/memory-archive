'use client';

import { useEffect, useState } from 'react';
import { listPhotoMonths, type PhotoMonths } from '@/lib/usecases/photo-assign';
import { viewerOffset } from './viewer-offset';
import { scopeOf, type PhotoFilter } from './use-photo-grid';
import { useLibraryInternals } from './use-library';

/** Pictures per month of one filter, for the jump control; read again when `version` changes. `undefined` while unknown or unreadable (the control is then simply absent). */
export function usePhotoMonths(filter: PhotoFilter, version: unknown): PhotoMonths | undefined {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [months, setMonths] = useState<PhotoMonths>();
  useEffect(() => {
    if (!deps) return;
    let alive = true;
    listPhotoMonths(deps, { scope: scopeOf(filter), zoneOffsetMinutes: viewerOffset }).then(
      (next) => alive && setMonths(next),
      () => alive && setMonths(undefined),
    );
    return () => {
      alive = false;
    };
  }, [deps, filter, version]);
  return months;
}
