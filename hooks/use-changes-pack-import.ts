'use client';

import { useCallback, useRef, useState } from 'react';
import { ArchiveError, type ArchiveErrorCode } from '@/lib/usecases/archive-backup';
import { ChangesPackMergeError, importChangesPack, type ChangesPackMergeCode, type ImportChangesPackResult } from '@/lib/usecases/changes-pack-import';
import { peekArchiveFile } from './peek-archive-file';
import { retryWhileBusy } from './retry-busy';
import { throttleProgress, type PackProgress } from './throttle-progress';
import { useLibraryInternals } from './use-library';

/** Why a pack was not merged: an archive code, a refusal of the pack's address, `not-a-pack` (a file that is neither), or `unknown`. Never text from the file. */
export type PackImportFailure = ArchiveErrorCode | ChangesPackMergeCode | 'not-a-pack' | 'unknown';

export type ChangesPackImportState =
  | { status: 'idle' }
  /** A protected pack is waiting for its password; `wrong` after an attempt that did not open it. The file stays with the hook. */
  | { status: 'asking'; fileName: string; wrong: boolean }
  | { status: 'working'; progress: PackProgress }
  | { status: 'done'; result: ImportChangesPackResult }
  /** The file is a full backup: nothing was read further, the screen points to Backup and restore. */
  | { status: 'is-backup'; fileName: string }
  | { status: 'failed'; code: PackImportFailure; fileName: string };

export interface ChangesPackImport {
  state: ChangesPackImportState;
  /** Looks at the picked file and merges it, asks for its password first when it is protected, or says it is a backup. */
  pick(file: File): Promise<void>;
  /** The password for the protected pack picked last. It is used for this call only. */
  unlock(password: string): Promise<void>;
  reset(): void;
}

/** "Import a pack": one at a time, with progress and a typed failure. A wrong password changes nothing and asks again. */
export function useChangesPackImport(onMerged?: () => void): ChangesPackImport {
  const { state: library, refresh } = useLibraryInternals();
  const [state, setState] = useState<ChangesPackImportState>({ status: 'idle' });
  const file = useRef<File | undefined>(undefined);
  const busy = useRef(false);

  const run = useCallback(
    async (picked: File, password?: string) => {
      if (library.status !== 'ready') return;
      const deps = library.deps;
      setState({ status: 'working', progress: { phase: 'preparing' } });
      const progress = throttleProgress((p) => setState({ status: 'working', progress: p }));
      try {
        const result = await retryWhileBusy(() =>
          importChangesPack(deps, picked, { password, onProgress: progress, onCryptoProgress: (p) => progress({ phase: 'decrypting', ...p }) }),
        );
        file.current = undefined;
        setState({ status: 'done', result });
        // The merge is committed; if reloading the screens fails, it still succeeded (a reload shows it).
        try {
          await refresh();
        } catch {
          // Not a failure of the merge.
        }
        onMerged?.();
      } catch (error) {
        if (error instanceof ArchiveError && error.code === 'wrong-password') {
          setState({ status: 'asking', fileName: picked.name, wrong: true });
          return;
        }
        file.current = undefined;
        const code: PackImportFailure = error instanceof ArchiveError ? error.code : error instanceof ChangesPackMergeError ? error.code : 'unknown';
        setState({ status: 'failed', code, fileName: picked.name });
      }
    },
    [library, refresh, onMerged],
  );

  const pick = useCallback(
    async (picked: File) => {
      if (library.status !== 'ready' || busy.current) return;
      busy.current = true;
      try {
        file.current = picked;
        setState({ status: 'working', progress: { phase: 'preparing' } });
        const kind = await peekArchiveFile(picked);
        if (kind === 'backup') {
          file.current = undefined;
          setState({ status: 'is-backup', fileName: picked.name });
        } else if (kind === 'unknown') {
          file.current = undefined;
          setState({ status: 'failed', code: 'not-a-pack', fileName: picked.name });
        } else if (kind === 'encrypted') {
          setState({ status: 'asking', fileName: picked.name, wrong: false });
        } else {
          await run(picked);
        }
      } finally {
        busy.current = false;
      }
    },
    [library, run],
  );

  const unlock = useCallback(
    async (password: string) => {
      const picked = file.current;
      if (!picked || busy.current) return;
      busy.current = true;
      try {
        await run(picked, password);
      } finally {
        busy.current = false;
      }
    },
    [run],
  );

  const reset = useCallback(() => {
    if (busy.current) return;
    file.current = undefined;
    setState({ status: 'idle' });
  }, []);

  return { state, pick, unlock, reset };
}
