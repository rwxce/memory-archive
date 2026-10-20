'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getDeviceStorageStatus,
  getSharedFiles,
  prepareDeviceStorage,
  type SharedFileInfo,
  type StorageStatus,
} from '@/lib/usecases/device-storage';

/** Space used / available and persistence; `undefined` while loading. */
export function useStorageStatus(): StorageStatus | undefined {
  const [status, setStatus] = useState<StorageStatus>();
  useEffect(() => {
    let alive = true;
    getDeviceStorageStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/** Ask the browser to keep this device's archive (the first "Start"). */
export function usePrepareStorage(): () => Promise<boolean | null> {
  return useCallback(() => prepareDeviceStorage(), []);
}

/** Files shared to the app and waiting for import; `undefined` while loading. */
export function useSharedFiles(): SharedFileInfo[] | undefined {
  const [files, setFiles] = useState<SharedFileInfo[]>();
  useEffect(() => {
    let alive = true;
    getSharedFiles()
      .catch(() => [])
      .then((f) => alive && setFiles(f));
    return () => {
      alive = false;
    };
  }, []);
  return files;
}
