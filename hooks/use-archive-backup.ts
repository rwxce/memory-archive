'use client';

import { useCallback, useState } from 'react';
import {
  ArchiveError,
  exportArchiveFromLibrary,
  restoreArchiveFromZip,
  type ArchiveErrorCode,
  type ArchiveProgress,
} from '@/lib/usecases/archive-backup';
import { downloadBlob } from './download-blob';
import { useLibraryInternals } from './use-library';

export type ArchiveBackupState =
  | { status: 'idle' }
  | { status: 'working'; kind: 'backup' | 'restore'; progress: ArchiveProgress }
  | { status: 'done'; kind: 'backup' | 'restore' }
  /** `code` is the `ArchiveError` code, or `'unknown'` for anything else (never contains text from the archive). */
  | { status: 'failed'; kind: 'backup' | 'restore'; code: ArchiveErrorCode | 'unknown' };

export interface ArchiveBackup {
  state: ArchiveBackupState;
  /** Builds the backup ZIP and downloads it. Resolves when the download was handed to the browser. */
  backup(): Promise<void>;
  /** Restores a ZIP the person picked into the (empty) library, then reloads the screens. */
  restore(file: Blob): Promise<void>;
}

/** "Fes una còpia de tot l'arxiu" and "Obre un arxiu": one operation at a time, with progress and a typed failure. */
export function useArchiveBackup(): ArchiveBackup {
  const { state: library, refresh } = useLibraryInternals();
  const [state, setState] = useState<ArchiveBackupState>({ status: 'idle' });

  const run = useCallback(
    async (kind: 'backup' | 'restore', work: (onProgress: (p: ArchiveProgress) => void) => Promise<void>) => {
      setState({ status: 'working', kind, progress: { phase: 'preparing' } });
      try {
        await work((progress) => setState({ status: 'working', kind, progress }));
        setState({ status: 'done', kind });
      } catch (error) {
        setState({ status: 'failed', kind, code: error instanceof ArchiveError ? error.code : 'unknown' });
      }
    },
    [],
  );

  const backup = useCallback(async () => {
    if (library.status !== 'ready') return;
    const deps = library.deps;
    await run('backup', async (onProgress) => {
      const { blob, fileName } = await exportArchiveFromLibrary(deps, { appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0', onProgress });
      downloadBlob(blob, fileName);
    });
  }, [library, run]);

  const restore = useCallback(
    async (file: Blob) => {
      if (library.status !== 'ready') return;
      const deps = library.deps;
      await run('restore', async (onProgress) => {
        await restoreArchiveFromZip(deps, file, { onProgress });
        await refresh();
      });
    },
    [library, refresh, run],
  );

  return { state, backup, restore };
}
