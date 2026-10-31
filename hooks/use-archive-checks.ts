'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveError, type ArchiveErrorCode } from '@/lib/usecases/archive-backup';
import {
  verifyBackupFile,
  verifyLibraryIntegrity,
  type BackupVerification,
  type IntegrityProgress,
  type LibraryIntegrity,
} from '@/lib/usecases/archive-health';
import { useLibraryInternals } from './use-library';

/** One check at a time: progress while it runs, then its result, a calm "stopped", or a typed failure. */
export type CheckState<Progress, Result> =
  | { status: 'idle' }
  | { status: 'running'; progress: Progress | undefined }
  | { status: 'done'; result: Result }
  | { status: 'cancelled' }
  /** `code` is the `ArchiveError` code, or `'unknown'` for anything else (never text from the archive). */
  | { status: 'failed'; code: ArchiveErrorCode | 'unknown' };

/** Progress updates reach the screen at most this often... */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * Whether a progress update should reach the screen: the first, the last (`fraction` 1), one at
 * least `PROGRESS_INTERVAL_MS` after the previous delivered, or one that moved a whole percent.
 * A walk over thousands of files would otherwise re-render the screen for every file.
 */
export function shouldDeliverProgress(previous: { at: number; percent: number } | undefined, fraction: number | undefined, now: number): boolean {
  if (!previous) return true;
  if (fraction !== undefined && fraction >= 1) return true;
  if (now - previous.at >= PROGRESS_INTERVAL_MS) return true;
  return fraction !== undefined && Math.floor(fraction * 100) > previous.percent;
}

/** The fraction (0-1) a progress value stands for, when it has a known total. */
type Fraction<Progress> = (progress: Progress) => number | undefined;

function useCheck<Progress, Result>(
  fraction: Fraction<Progress>,
  work: (signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<Result> | undefined,
) {
  const [state, setState] = useState<CheckState<Progress, Result>>({ status: 'idle' });
  const controller = useRef<AbortController>(undefined);
  const workRef = useRef(work);
  workRef.current = work;

  // Leaving the screen stops a running check.
  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted && state.status === 'running') return;
    const own = new AbortController();
    let delivered: { at: number; percent: number } | undefined;
    const job = workRef.current(own.signal, (progress) => {
      if (controller.current !== own) return;
      const f = fraction(progress);
      const now = Date.now();
      if (!shouldDeliverProgress(delivered, f, now)) return;
      delivered = { at: now, percent: f === undefined ? -1 : Math.floor(f * 100) };
      setState({ status: 'running', progress });
    });
    if (!job) return;
    controller.current = own;
    setState({ status: 'running', progress: undefined });
    try {
      const result = await job;
      if (controller.current === own) setState({ status: 'done', result });
    } catch (error) {
      if (controller.current !== own) return;
      if (own.signal.aborted) setState({ status: 'cancelled' });
      else setState({ status: 'failed', code: error instanceof ArchiveError ? error.code : 'unknown' });
    }
  }, [state.status, fraction]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, start, cancel, reset };
}

const integrityFraction: Fraction<IntegrityProgress> = (p) => (p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.total > 0 ? p.done / p.total : undefined);
const countFraction: Fraction<{ done: number; total: number }> = (p) => (p.total > 0 ? p.done / p.total : undefined);

/** "Check my archive": every stored file is present and intact. Read-only; Cancel stops between files. */
export function useLibraryCheck() {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const check = useCheck<IntegrityProgress, LibraryIntegrity>(integrityFraction, (signal, onProgress) =>
    deps ? verifyLibraryIntegrity(deps, { signal, onProgress }) : undefined,
  );
  return { state: check.state, run: check.start, cancel: check.cancel, reset: check.reset };
}

/** Progress of a file check: parts checked, or (`phase: 'decrypting'`) the password step that comes first. */
export type FileCheckProgress = { done: number; total: number; phase?: 'decrypting' };

/**
 * "Check a backup file": verifies a backup the person picked without restoring it. Needs no library. An encrypted
 * file needs its `password`; a wrong one comes back as a `wrong-password` refusal so the caller can ask again. The
 * password is handed to the check once and not kept.
 */
export function useBackupFileCheck() {
  const file = useRef<Blob>(undefined);
  const secret = useRef<string>(undefined);
  const check = useCheck<FileCheckProgress, BackupVerification>(countFraction, (signal, onProgress) =>
    file.current
      ? verifyBackupFile(file.current, {
          signal,
          password: secret.current,
          onProgress,
          onCryptoProgress: (p) => onProgress({ ...p, phase: 'decrypting' }),
        })
      : undefined,
  );
  const run = useCallback(
    (picked: Blob, password?: string) => {
      file.current = picked;
      secret.current = password || undefined;
      const job = check.start();
      // The check has read it by now (the work starts synchronously): forget it.
      secret.current = undefined;
      return job;
    },
    [check],
  );
  return { state: check.state, run, cancel: check.cancel, reset: check.reset };
}
