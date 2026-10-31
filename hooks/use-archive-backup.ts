'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ArchiveError,
  exportArchiveFromLibrary,
  replaceLibraryFromBackup,
  restoreArchiveFromZip,
  type ArchiveErrorCode,
  type ArchiveProgress,
  type ReplaceProgress,
} from '@/lib/usecases/archive-backup';
import { downloadBlob } from './download-blob';
import { useLibraryInternals } from './use-library';

export type ArchiveKind = 'backup' | 'restore' | 'replace';

export type ArchiveBackupState =
  | { status: 'idle' }
  /** `stage` is set while replacing; `cancellable` is false once the swap has begun and cannot be stopped. */
  | { status: 'working'; kind: ArchiveKind; progress: ArchiveProgress; stage?: ReplaceProgress['stage']; cancellable?: boolean }
  /** `safetyBackupFileName`: the safety copy handed to the browser while replacing a library that had data. */
  | { status: 'done'; kind: ArchiveKind; safetyBackupFileName?: string }
  /**
   * `code` is the `ArchiveError` code, `'cancelled'` when the person stopped a replace, or `'unknown'` for anything
   * else (never contains text from the archive). `safetyBackupFileName` is set when a safety copy was already handed to the browser.
   */
  | { status: 'failed'; kind: ArchiveKind; code: ArchiveErrorCode | 'cancelled' | 'unknown'; safetyBackupFileName?: string };

export interface ArchiveBackup {
  state: ArchiveBackupState;
  /** Builds the backup ZIP and downloads it. Resolves when the download was handed to the browser. */
  backup(): Promise<void>;
  /** Restores a ZIP the person picked into the (empty) library, then reloads the screens. */
  restore(file: Blob): Promise<void>;
  /**
   * Replaces the whole library with a backup the person picked, after saving a safety copy of the current one
   * (downloaded before anything changes). Reloads the screens when done.
   */
  replace(file: Blob): Promise<void>;
  /** Stops a replace that has not reached the swap yet; the library stays exactly as it was. */
  cancel(): void;
}

/** "Fes una còpia de tot l'arxiu" and "Obre un arxiu": one operation at a time, with progress and a typed failure. */
export function useArchiveBackup(): ArchiveBackup {
  const { state: library, refresh } = useLibraryInternals();
  const [state, setState] = useState<ArchiveBackupState>({ status: 'idle' });
  const controller = useRef<AbortController | undefined>(undefined);
  /** The safety copy already handed to the browser by the replace in progress. */
  const savedCopy = useRef<string | undefined>(undefined);
  /** True while an operation runs: a second call is ignored, so it cannot overwrite the first one's state. */
  const busy = useRef(false);

  const run = useCallback(
    async (kind: ArchiveKind, work: (onProgress: (p: ArchiveProgress, stage?: ReplaceProgress['stage']) => void) => Promise<{ safetyBackupFileName?: string } | void>) => {
      if (busy.current) return;
      busy.current = true;
      setState({ status: 'working', kind, progress: { phase: 'preparing' } });
      try {
        const outcome = await work((progress, stage) =>
          setState({ status: 'working', kind, progress, stage, cancellable: stage === undefined ? undefined : !(stage === 'restoring' && progress.phase === 'finishing') }),
        );
        setState({ status: 'done', kind, safetyBackupFileName: outcome?.safetyBackupFileName });
      } catch (error) {
        const cancelled = kind === 'replace' && controller.current?.signal.aborted === true && !(error instanceof ArchiveError);
        const code = cancelled ? 'cancelled' : error instanceof ArchiveError ? error.code : 'unknown';
        setState({ status: 'failed', kind, code, safetyBackupFileName: kind === 'replace' ? savedCopy.current : undefined });
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  /** The change is already committed; if reloading the screens fails, the work still succeeded (a reload shows it). */
  const refreshAfterCommit = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // Not a failure of the restore or replace.
    }
  }, [refresh]);

  const backup = useCallback(async () => {
    if (library.status !== 'ready' || busy.current) return;
    const deps = library.deps;
    await run('backup', async (onProgress) => {
      const { blob, fileName } = await exportArchiveFromLibrary(deps, { appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0', onProgress });
      downloadBlob(blob, fileName);
    });
  }, [library, run]);

  const restore = useCallback(
    async (file: Blob) => {
      if (library.status !== 'ready' || busy.current) return;
      const deps = library.deps;
      await run('restore', async (onProgress) => {
        await restoreArchiveFromZip(deps, file, { onProgress });
        await refreshAfterCommit();
      });
    },
    [library, refreshAfterCommit, run],
  );

  const replace = useCallback(
    async (file: Blob) => {
      if (library.status !== 'ready' || busy.current) return;
      const deps = library.deps;
      const abort = new AbortController();
      controller.current = abort;
      savedCopy.current = undefined;
      await run('replace', async (onProgress) => {
        const result = await replaceLibraryFromBackup(deps, file, {
          appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
          signal: abort.signal,
          onProgress: ({ stage, progress }) => onProgress(progress, stage),
          // The browser saves the safety copy; the replace goes on only after this resolves.
          deliverSafetyBackup: async (blob, fileName) => {
            downloadBlob(blob, fileName);
            savedCopy.current = fileName;
          },
        });
        await refreshAfterCommit();
        return result;
      });
    },
    [library, refreshAfterCommit, run],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);

  return { state, backup, restore, replace, cancel };
}
