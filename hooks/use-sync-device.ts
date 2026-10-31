'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SyncPeer } from '@/lib/domain/sync';
import { getDeviceId, listPeers } from '@/lib/usecases/sync-state';
import { useLibraryInternals } from './use-library';

export type SyncDeviceState =
  | { status: 'loading' }
  | { status: 'ready'; deviceId: string; peers: SyncPeer[] }
  | { status: 'error' };

/** The first characters of a device id: enough to tell two devices apart, short enough to read aloud. */
export const shortDeviceId = (deviceId: string): string => deviceId.slice(0, 8);

/** This device's id and the devices it has exchanged packs with. `reload` reads them again (after a pack was handed over or merged). */
export function useSyncDevice(): { state: SyncDeviceState; reload: () => void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<SyncDeviceState>({ status: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    Promise.all([getDeviceId(deps), listPeers(deps)]).then(
      ([deviceId, peers]) => alive && setState({ status: 'ready', deviceId, peers }),
      () => alive && setState({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state, reload };
}
