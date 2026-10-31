'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhotoBatch } from '@/lib/domain/photo';
import { listPhotoBatches, undoPhotoImport } from '@/lib/usecases/photo-library';
import { photoFailureOf, type PhotoFailure } from './use-photo-import';
import { retryWhileBusy } from './retry-busy';
import { useLibraryInternals } from './use-library';

export type PhotoBatchesState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; batches: PhotoBatch[] };

export type PhotoUndoState =
  | { status: 'idle' }
  | { status: 'working'; batchId: string }
  /** `removedItems` is 0 when the import was already gone. */
  | { status: 'done'; removedItems: number; removedAssignments: number }
  | { status: 'failed'; batchId: string; code: PhotoFailure };

export interface PhotoBatches {
  state: PhotoBatchesState;
  undo: PhotoUndoState;
  /** Takes one import back. One at a time; the list is read again afterwards. */
  undoBatch(batchId: string): Promise<void>;
  /** Reads the list again (after an import). */
  reload(): Promise<void>;
  /** Forgets the last undo's result (the next action has begun). Does nothing while an undo runs. */
  clearOutcome(): void;
}

/** The imports that added pictures, newest first, and taking one back. */
export function usePhotoBatches(): PhotoBatches {
  const { state: library, register } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<PhotoBatchesState>({ status: 'loading' });
  const [undo, setUndo] = useState<PhotoUndoState>({ status: 'idle' });
  const latest = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    try {
      const batches = await listPhotoBatches(deps);
      if (mine === latest.current) setState({ status: 'ready', batches });
    } catch {
      if (mine === latest.current) setState({ status: 'error' });
    }
  }, [deps]);

  useEffect(() => {
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [load, register]);

  const undoBatch = useCallback(
    async (batchId: string) => {
      if (!deps || busy.current) return;
      busy.current = true;
      setUndo({ status: 'working', batchId });
      try {
        const result = await retryWhileBusy(() => undoPhotoImport(deps, batchId));
        setUndo({ status: 'done', removedItems: result.removedItems, removedAssignments: result.removedAssignments });
      } catch (error) {
        setUndo({ status: 'failed', batchId, code: photoFailureOf(error) });
      } finally {
        busy.current = false;
      }
      await load();
    },
    [deps, load],
  );

  const clearOutcome = useCallback(() => setUndo((now) => (now.status === 'working' || now.status === 'idle' ? now : { status: 'idle' })), []);

  return { state, undo, undoBatch, reload: load, clearOutcome };
}
