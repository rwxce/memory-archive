import type { DbClient } from '../db/client';
import type { BlobStore } from '../storage/blob-store';
import { isArchiveBusy, withArchiveGuard } from './archive-guard';
import { ArchiveError } from '../exporters/archive/format';
import type { ImportPreview, PreviewProgress } from './import-preview';
import { ImportError, type ImportProgress, type ImportResult } from './import';
import {
  fromImportFailure,
  type ImportWorkerEvent,
  type ImportWorkerInput,
  type ImportWorkerRequest,
  type PreviewWorkerInput,
} from './import-protocol';

/**
 * The page's side of the import worker: runs ONE import in a fresh worker and settles with its
 * result, typed error or abort. A new worker per import keeps no state between imports and lets
 * `terminate()` be the answer to every "the worker is stuck" question.
 *
 * Guarantees, the same as the in-thread `importWhatsAppExport` (the worker runs that very code):
 * - The page's archive busy guard is held for the whole run (a restore or undo started in this
 *   tab meanwhile is `busy`); the worker holds the cross-tab lock (another tab's is `busy`).
 * - `signal` aborts: the archive is unchanged unless the save step had already started, in which
 *   case the import commits whole and resolves normally (a late cancel is not an error).
 * - The worker crashing, failing to load or ignoring a cancel rejects with `ImportError`
 *   `worker-failed`. The archive then holds the whole batch or nothing; the media written so far
 *   are orphans that the next `sweepOrphanBlobs` removes. Running the import again is safe.
 */
export interface ImportWorkerTransport {
  post(message: ImportWorkerRequest, transfer: Transferable[]): void;
  onMessage(listener: (event: ImportWorkerEvent) => void): void;
  onFailure(listener: (message: string) => void): void;
  terminate(): void;
}

/** Starts the real worker (browser only) from its built URL, e.g. `${basePath}/db/import-worker.js`. */
export function createImportWorkerTransport(workerUrl: string | URL): ImportWorkerTransport {
  const worker = new Worker(workerUrl, { type: 'module' });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    onMessage: (listener) => {
      worker.onmessage = (event: MessageEvent<ImportWorkerEvent>) => listener(event.data);
    },
    onFailure: (listener) => {
      worker.onerror = (event) => listener(event.message || 'the import worker failed to start');
      worker.onmessageerror = () => listener('the import worker sent an unreadable message');
    },
    terminate: () => worker.terminate(),
  };
}

export interface ImportInWorkerOptions {
  /** Where the built import worker is served, e.g. `${basePath}/db/import-worker.js`. */
  workerUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** After a cancel, how long the worker may take to stop before it is terminated. Default 15 s. */
  cancelGraceMs?: number;
  /** Test seam: the real worker is used when absent. */
  createTransport?: () => ImportWorkerTransport;
}

export const DEFAULT_CANCEL_GRACE_MS = 15_000;

const abortReason = (signal: AbortSignal | undefined) => signal?.reason ?? new DOMException('The import was cancelled', 'AbortError');

interface WorkerJob<Progress> {
  deps: { client: Pick<DbClient, 'connectPort'> };
  start(port: MessagePort): ImportWorkerRequest;
  /** The event that carries the result, and the one that carries progress. */
  resultEvent: 'done' | 'preview-done';
  progressEvent: 'progress' | 'preview-progress';
  /** After this progress there is no point in cancelling: the outcome decides (the import's save step). */
  pastNoReturn?(progress: Progress): boolean;
  options: {
    workerUrl: string;
    signal?: AbortSignal;
    onProgress?: (progress: Progress) => void;
    cancelGraceMs?: number;
    createTransport?: () => ImportWorkerTransport;
  };
}

/** One job (an import or a preview) in a fresh worker; the semantics are in the file's first comment. */
function runWorkerJob<Result, Progress>(job: WorkerJob<Progress>): Promise<Result> {
  const { options } = job;
  const { signal } = options;
  signal?.throwIfAborted();
  const port = job.deps.client.connectPort();
  const transport = (options.createTransport ?? (() => createImportWorkerTransport(options.workerUrl)))();
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let pastNoReturn = false;
    const onAbort = () => {
      transport.post({ type: 'cancel' }, []);
      // Past the save step a cancel changes nothing: no timer, the outcome decides.
      if (pastNoReturn) return;
      graceTimer = setTimeout(
        () => finish(() => reject(new ImportError('worker-failed', 'the import worker did not stop after the cancel'))),
        options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      );
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      transport.terminate();
      port.close();
      settle();
    };

    transport.onMessage((event) => {
      if (settled) return;
      // Explicit dispatch on a message from another thread; anything unknown is ignored.
      switch (event?.type) {
        case job.progressEvent: {
          const progress = (event as unknown as { progress: Progress }).progress;
          if (job.pastNoReturn?.(progress)) {
            // The save is one database transaction that may still commit: wait for the outcome.
            pastNoReturn = true;
            clearTimeout(graceTimer);
          }
          try {
            options.onProgress?.(progress);
          } catch {
            // A broken progress listener must not break the job.
          }
          return;
        }
        case job.resultEvent:
          finish(() => resolve((event as unknown as { result: Result }).result));
          return;
        case 'error': {
          let error: Error | undefined;
          try {
            error = fromImportFailure(event.error);
          } catch {
            error = new ImportError('worker-failed', 'the import worker sent an unreadable error');
          }
          finish(() => reject(error ?? abortReason(signal)));
          return;
        }
      }
    });
    transport.onFailure((message) => finish(() => reject(new ImportError('worker-failed', message))));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      transport.post(job.start(port), [port]);
    } catch (error) {
      finish(() => reject(new ImportError('worker-failed', error instanceof Error ? error.message : String(error))));
    }
  });
}

export function importWhatsAppExportInWorker(
  deps: { client: Pick<DbClient, 'connectPort'>; blobStore: BlobStore },
  input: ImportWorkerInput,
  options: ImportInWorkerOptions,
): Promise<ImportResult> {
  // No lock here: the worker takes it, in its own thread, for the length of the import.
  return withArchiveGuard(deps.blobStore, () =>
    runWorkerJob<ImportResult, ImportProgress>({
      deps,
      options,
      start: (dbPort) => ({ type: 'start', input, dbPort }),
      resultEvent: 'done',
      progressEvent: 'progress',
      pastNoReturn: (progress) => progress?.phase === 'saving',
    }),
  );
}

export interface PreviewInWorkerOptions {
  workerUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: PreviewProgress) => void;
  cancelGraceMs?: number;
  createTransport?: () => ImportWorkerTransport;
}

/**
 * A read-only preview of an export in a fresh worker (`previewWhatsAppExport` runs there). Same
 * error, abort and crash semantics as the import (`ImportError` `worker-failed` for a crash, an
 * unloadable worker or a cancel it ignores for the grace period; typed codes survive), minus
 * everything about writing: nothing is stored or committed, so an abort, a crash or a hard kill
 * leaves nothing behind, and there is no archive lock and no busy guard of its own.
 *
 * It does refuse to start (`ArchiveError` `busy`) while an archive operation (restore, import,
 * undo, backup, sweep) runs in this tab: a restore swaps the library the preview would read, and
 * a preview of the next file during an import would describe a library that is about to change.
 * The reverse is not enforced: an operation that starts during a preview does not wait for it
 * (the preview is advisory; the import decides again under the lock).
 */
export async function previewWhatsAppExportInWorker(
  deps: { client: Pick<DbClient, 'connectPort'>; blobStore: BlobStore },
  input: PreviewWorkerInput,
  options: PreviewInWorkerOptions,
): Promise<ImportPreview> {
  if (isArchiveBusy(deps.blobStore)) {
    throw new ArchiveError('busy', 'another archive operation is already running');
  }
  return runWorkerJob<ImportPreview, PreviewProgress>({
    deps,
    options,
    start: (dbPort) => ({ type: 'preview', input, dbPort }),
    resultEvent: 'preview-done',
    progressEvent: 'preview-progress',
  });
}
