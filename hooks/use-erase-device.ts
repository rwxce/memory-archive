'use client';

import { useCallback } from 'react';
import { eraseDevice, type EraseDeviceResult } from '@/lib/usecases/erase-device';
import { useLibraryRelease } from './use-library';

/** Erases everything this app keeps on the device; resolves with what could not be erased (never rejects). */
export function useEraseDevice(): () => Promise<EraseDeviceResult> {
  const release = useLibraryRelease();
  return useCallback(async () => {
    let root: FileSystemDirectoryHandle | undefined;
    try {
      root = await navigator.storage?.getDirectory?.();
    } catch {
      root = undefined;
    }
    return eraseDevice({
      library: { close: () => release() },
      root: root as Parameters<typeof eraseDevice>[0]['root'],
      cacheStorage: typeof caches === 'undefined' ? undefined : caches,
      localStorage: typeof localStorage === 'undefined' ? undefined : localStorage,
      sessionStorage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
    });
  }, [release]);
}
