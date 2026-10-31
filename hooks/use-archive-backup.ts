'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ArchiveError,
  exportArchiveFromLibrary,
  replaceLibraryFromBackup,
  restoreArchiveFromZip,
  type ArchiveErrorCode,
  type ArchiveProgress,
  type CryptoProgress,
  type ReplaceProgress,
} from '@/lib/usecases/archive-backup';
import { downloadBlob } from './download-blob';
import { useLibraryInternals } from './use-library';

export type ArchiveKind = 'backup' | 'restore' | 'replace';

/** The archive's own progress, plus the password step: `encrypting` after a backup is built, `decrypting` before a protected one is opened. */
export type BackupProgress = ArchiveProgress | ({ phase: 'encrypting' | 'decrypting' } & CryptoProgress);

export type ArchiveBackupState =
  | { status: 'idle' }
  /** `stage` is set while replacing; `cancellable` is false once the swap has begun and cannot be stopped. */
  | { status: 'working'; kind: ArchiveKind; progress: BackupProgress; stage?: ReplaceProgress['stage']; cancellable?: boolean }
  /**
   * `safetyBackupFileName`: the safety copy handed to the browser while replacing a library that had data.
   * `encrypted`: for a backup, whether the file saved is password-protected (`false` = a plain ZIP anyone can read).
   */
  | { status: 'done'; kind: ArchiveKind; safetyBackupFileName?: string; encrypted?: boolean }
  /**
   * `code` is the `ArchiveError` code, `'cancelled'` when the person stopped a replace, or `'unknown'` for anything
   * else (never contains text from the archive). `safetyBackupFileName` is set when a safety copy was already handed to the browser.
   */
  | { status: 'failed'; kind: ArchiveKind; code: ArchiveErrorCode | 'cancelled' | 'unknown'; safetyBackupFileName?: string };

export interface ArchiveBackup {
  state: ArchiveBackupState;
  /**
   * Builds the backup and downloads it. With a `password` the file is encrypted (`.mabackup`); without one it is a
   * plain ZIP. Resolves when the download was handed to the browser. The password is used for this call only.
   */
  backup(options?: { password?: string }): Promise<void>;
  /**
   * Restores a backup the person picked into the (empty) library, then reloads the screens. `password` is needed for an
   * encrypted file; a wrong one fails with `wrong-password` and changes nothing, so the caller can ask again.
   */
  restore(file: Blob, password?: string): Promise<void>;
  /**
   * Replaces the whole library with a backup the person picked, after saving a safety copy of the current one
   * (downloaded before anything changes; that copy is not encrypted). Reloads the screens when done. `password` as in `restore`.
   */
  replace(file: Blob, password?: string): Promise<void>;
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
    async (kind: ArchiveKind, work: (onProgress: (p: BackupProgress, stage?: ReplaceProgress['stage']) => void) => Promise<{ safetyBackupFileName?: string; encrypted?: boolean } | void>) => {
      if (busy.current) return;
      busy.current = true;
      setState({ status: 'working', kind, progress: { phase: 'preparing' } });
      try {
        const outcome = await work((progress, stage) =>
          setState({ status: 'working', kind, progress, stage, cancellable: stage === undefined ? undefined : !(stage === 'restoring' && progress.phase === 'finishing') }),
        );
        setState({ status: 'done', kind, safetyBackupFileName: outcome?.safetyBackupFileName, encrypted: outcome?.encrypted });
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

  const backup = useCallback(
    async (options?: { password?: string }) => {
      if (library.status !== 'ready' || busy.current) return;
      const deps = library.deps;
      // Passed through unchanged: an empty string must reach the core, which refuses it (fail closed).
      const password = options?.password;
      await run('backup', async (onProgress) => {
        const { blob, fileName, encrypted } = await exportArchiveFromLibrary(deps, {
          appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
          onProgress,
          password,
          onCryptoProgress: (p) => onProgress({ phase: 'encrypting', ...p }),
        });
        downloadBlob(blob, fileName);
        return { encrypted };
      });
    },
    [library, run],
  );

  const restore = useCallback(
    async (file: Blob, password?: string) => {
      if (library.status !== 'ready' || busy.current) return;
      const deps = library.deps;
      await run('restore', async (onProgress) => {
        await restoreArchiveFromZip(deps, file, {
          onProgress,
          password: password || undefined,
          onCryptoProgress: (p) => onProgress({ phase: 'decrypting', ...p }),
        });
        await refreshAfterCommit();
      });
    },
    [library, refreshAfterCommit, run],
  );

  const replace = useCallback(
    async (file: Blob, password?: string) => {
      if (library.status !== 'ready' || busy.current) return;
      const deps = library.deps;
      const abort = new AbortController();
      controller.current = abort;
      savedCopy.current = undefined;
      await run('replace', async (onProgress) => {
        const result = await replaceLibraryFromBackup(deps, file, {
          appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
          signal: abort.signal,
          password: password || undefined,
          // Opening the protected backup comes before the safety copy, so it has no step number.
          onCryptoProgress: (p) => onProgress({ phase: 'decrypting', ...p }),
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
