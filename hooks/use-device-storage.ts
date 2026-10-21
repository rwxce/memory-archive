'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getDeviceStorageStatus,
  discardSharedFile,
  getSharedFiles,
  prepareDeviceStorage,
  takeSharedFile,
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

export interface SharedInbox {
  /** `undefined` while loading. */
  files: SharedFileInfo[] | undefined;
  /** The file's content, or `undefined` when it is gone. */
  take(info: SharedFileInfo): Promise<File | undefined>;
  /** Forgets the file (imported or not wanted) and updates the list. */
  discard(key: string): Promise<void>;
}

/** The files shared to the app (Web Share Target) and what can be done with them. */
export function useSharedInbox(): SharedInbox {
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
  return useMemo(
    () => ({
      files,
      take: (info) => takeSharedFile(info).catch(() => undefined),
      discard: async (key) => {
        await discardSharedFile(key).catch(() => false);
        setFiles((current) => current?.filter((f) => f.key !== key));
      },
    }),
    [files],
  );
}
