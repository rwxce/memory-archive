'use client';

import { useCallback, useRef, useState } from 'react';
import { ArchiveError } from '@/lib/usecases/archive-backup';
import { importGooglePhotosZip, importLoosePhotos, type PhotoImportSummary } from '@/lib/usecases/photo-import';
import { importTakeoutAlbum } from '@/lib/usecases/photo-library';
import { detectPhotoSource } from '@/lib/usecases/photo-source';
import { retryWhileBusy } from './retry-busy';
import { throttleProgress, type PackProgress } from './throttle-progress';
import { useLibraryInternals } from './use-library';

/** Why pictures were not added. Never text from a file; each maps to one calm message. */
export type PhotoFailure = 'invalid' | 'unreadable' | 'limit' | 'busy' | 'closed' | 'newer' | 'storage' | 'generic';

/** A named error with a string `code`, whichever layer threw it (the worker revives database errors by name). */
const coded = (error: unknown, name: string): string | undefined =>
  error instanceof Error && error.name === name && typeof (error as { code?: unknown }).code === 'string' ? (error as unknown as { code: string }).code : undefined;

/** Maps what the photo use cases throw (`TakeoutError`, `ArchiveError`, `DbError`, a full disk) to a message key. */
export function photoFailureOf(error: unknown): PhotoFailure {
  if (error instanceof ArchiveError) {
    if (error.code === 'busy') return 'busy';
    if (error.code === 'storage') return 'storage';
    if (error.code === 'limit-exceeded') return 'limit';
    return error.code === 'newer-schema' || error.code === 'newer-format' ? 'newer' : 'generic';
  }
  switch (coded(error, 'TakeoutError')) {
    case 'invalid-takeout':
    case 'unsafe-path':
      return 'invalid';
    case 'unreadable-files':
      return 'unreadable';
    case 'limit-exceeded':
      return 'limit';
  }
  switch (coded(error, 'DbError')) {
    case 'newer-schema':
      return 'newer';
    case 'closed':
    case 'unavailable':
      return 'closed';
    case 'too-large':
      return 'limit';
  }
  // A file the browser could not read (moved, cloud-only, permission withdrawn) is not the app's fault: say so calmly.
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'NotReadableError' || name === 'NotFoundError') return 'unreadable';
  if (coded(error, 'BlobStoreError') === 'io' || name === 'QuotaExceededError') return 'storage';
  return 'generic';
}

/** A file that belongs to another part of the app: the screen points there and adds nothing. */
export type PhotoElsewhere = 'chat' | 'backup' | 'sync';

export interface PhotoRunResult {
  /** Which choice this run came from: only a finished `loose` run spends the person's loose choice. */
  kind: 'loose' | 'zip';
  summary: PhotoImportSummary;
  /** A Google Photos download laid out as a Takeout was read as one. */
  delegatedToTakeout: boolean;
}

export type PhotoRunState =
  | { status: 'idle' }
  | { status: 'checking'; fileName: string }
  /** `cancellable` is false once the save has begun: it commits whole and cannot be stopped half way. */
  | { status: 'working'; progress: PackProgress; cancellable: boolean }
  | { status: 'done'; result: PhotoRunResult }
  /** The person stopped it: nothing was added. */
  | { status: 'stopped' }
  | { status: 'elsewhere'; where: PhotoElsewhere; fileName: string }
  | { status: 'failed'; code: PhotoFailure; fileName?: string };

export interface PhotoImport {
  state: PhotoRunState;
  /**
   * Looks at a picked ZIP (or any file) by its content and adds it to the collection. Resolves `'media'` for one
   * picture or video (nothing was done: the caller adds it to the loose choice), `'handled'` otherwise.
   */
  pickFile(file: File): Promise<'media' | 'handled'>;
  /** Adds pictures and videos chosen from the device, grouped under `label` when given. */
  importLoose(files: readonly File[], label: string): Promise<void>;
  /** True after a pick or add was refused because another import was running: the screen says so calmly. */
  refused: boolean;
  /** Stops an import that has not reached its save; nothing is left half added. */
  cancel(): void;
  reset(): void;
}

/** Maps the importer's steps to the sentences the screen already has ("Getting ready…", "Copying files: 3 of 12", "Finishing…"). */
const packProgressOf = (p: { phase: 'reading' | 'media' | 'saving'; done: number; total: number }): PackProgress =>
  p.phase === 'media' ? { phase: 'media', done: p.done, total: p.total } : { phase: p.phase === 'reading' ? 'preparing' : 'finishing' };

/** The error is the abort itself (the signal's reason, or any AbortError), not a failure that happened to follow it. */
const isAbort = (error: unknown, signal: AbortSignal) => error === signal.reason || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError');

/** "Add pictures": one import at a time, with progress, a Stop that leaves nothing half added, and a typed failure. */
export function usePhotoImport(onSettled?: () => void): PhotoImport {
  const { state: library } = useLibraryInternals();
  const [state, setState] = useState<PhotoRunState>({ status: 'idle' });
  const controller = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const saveBegun = useRef(false);
  const [refused, setRefused] = useState(false);

  const run = useCallback(
    async (start: (signal: AbortSignal, onProgress: (p: { phase: 'reading' | 'media' | 'saving'; done: number; total: number }) => void) => Promise<PhotoRunResult>, fileName?: string) => {
      const abort = new AbortController();
      controller.current = abort;
      saveBegun.current = false;
      setState({ status: 'working', progress: { phase: 'preparing' }, cancellable: true });
      const deliver = throttleProgress((progress) => setState({ status: 'working', progress, cancellable: progress.phase !== 'finishing' }));
      try {
        const result = await retryWhileBusy(() => start(abort.signal, (p) => {
              if (p.phase === 'saving') saveBegun.current = true;
              deliver(packProgressOf(p));
            }),
          abort.signal,
        );
        setState({ status: 'done', result });
      } catch (error) {
        // "Stopped, nothing added" is only true if the error IS the abort and the save never began; otherwise it may have committed.
        const stopped = abort.signal.aborted && !saveBegun.current && isAbort(error, abort.signal);
        setState(stopped ? { status: 'stopped' } : { status: 'failed', code: photoFailureOf(error), fileName });
      } finally {
        controller.current = undefined;
        onSettled?.(); // whatever happened, the list shows what is really there
      }
    },
    [onSettled],
  );

  const pickFile = useCallback(
    async (file: File): Promise<'media' | 'handled'> => {
      if (library.status !== 'ready') {
        setState({ status: 'failed', code: 'closed', fileName: file.name });
        return 'handled';
      }
      if (busy.current) {
        setRefused(true);
        return 'handled';
      }
      busy.current = true;
      setRefused(false);
      try {
        const deps = library.deps;
        setState({ status: 'checking', fileName: file.name });
        let kind;
        try {
          kind = (await detectPhotoSource(file)).kind;
        } catch (error) {
          setState({ status: 'failed', code: photoFailureOf(error), fileName: file.name });
          return 'handled';
        }
        if (kind === 'media') {
          setState({ status: 'idle' });
          return 'media';
        }
        const elsewhere: Partial<Record<typeof kind, PhotoElsewhere>> = { 'whatsapp-chat': 'chat', backup: 'backup', 'changes-pack': 'sync' };
        const where = elsewhere[kind];
        if (where) setState({ status: 'elsewhere', where, fileName: file.name });
        else if (kind === 'unsupported') setState({ status: 'failed', code: 'invalid', fileName: file.name });
        else if (kind === 'takeout-album') {
          await run(async (signal, onProgress) => {
            const r = await importTakeoutAlbum(deps, { zip: file, fileName: file.name, signal, onProgress });
            return { kind: 'zip', summary: { ...r.summary, dateGuessed: 0, unreadableFiles: 0 }, delegatedToTakeout: false };
          }, file.name);
        } else {
          await run(async (signal, onProgress) => {
            const r = await importGooglePhotosZip(deps, { zip: file, fileName: file.name, signal, onProgress });
            return { kind: 'zip', summary: r.summary, delegatedToTakeout: r.delegatedToTakeout };
          }, file.name);
        }
        return 'handled';
      } finally {
        busy.current = false;
        setRefused(false);
      }
    },
    [library, run],
  );

  const importLoose = useCallback(
    async (files: readonly File[], label: string) => {
      if (files.length === 0) return;
      if (library.status !== 'ready') {
        setState({ status: 'failed', code: 'closed' });
        return;
      }
      if (busy.current) {
        setRefused(true);
        return;
      }
      busy.current = true;
      setRefused(false);
      try {
        const deps = library.deps;
        await run(async (signal, onProgress) => {
          const r = await importLoosePhotos(deps, { files, label, signal, onProgress });
          return { kind: 'loose', summary: r.summary, delegatedToTakeout: false };
        });
      } finally {
        busy.current = false;
        setRefused(false);
      }
    },
    [library, run],
  );

  // Once the save has begun it commits whole: a late Stop must not pretend it can undo that.
  const cancel = useCallback(() => {
    if (!saveBegun.current) controller.current?.abort();
  }, []);
  const reset = useCallback(() => {
    if (!busy.current) setState({ status: 'idle' });
  }, []);

  return { state, refused, pickFile, importLoose, cancel, reset };
}
