'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getDeviceStorageStatus } from '@/lib/usecases/device-storage';
import { undoImportBatch, type ImportProgress, type ImportResult, type UndoImportResult } from '@/lib/usecases/import';
import {
  importWhatsAppExportInWorker,
  previewWhatsAppExportInWorker,
  type ImportWorkerTransport,
} from '@/lib/usecases/import-client';
import type { ImportPreview, PreviewProgress } from '@/lib/usecases/import-preview';
import { importProblemOf, importRequest, previewRequest, type WizardChoices } from '@/lib/usecases/import-wizard';
import { useLibraryInternals } from './use-library';

/** Tests hand in a worker wired in-thread; the app starts the real one. */
const TransportContext = createContext<(() => ImportWorkerTransport) | undefined>(undefined);
export function ImportTransportProvider({ createTransport, children }: { createTransport: () => ImportWorkerTransport; children: ReactNode }) {
  return <TransportContext.Provider value={createTransport}>{children}</TransportContext.Provider>;
}

/**
 * A preview is refused (`busy`) while an archive operation runs in this tab, and the library's own
 * clean-up at open is one. It ends within moments, so a refused preview is tried again a few times
 * before the person is told.
 */
const BUSY_RETRY_MS = 250;
const BUSY_RETRIES = 12;

async function whileBusy<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (importProblemOf(error) !== 'busy' || attempt >= BUSY_RETRIES) throw error;
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      signal?.throwIfAborted();
    }
  }
}

export interface ImportControl<Progress> {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export interface ImportActions {
  /** A read-only look at a file under the choices made so far. Rejects with a typed error (see `importProblemOf`). */
  preview(
    file: File,
    choices: Pick<WizardChoices, 'profileIds' | 'conversation' | 'dateOrder'>,
    control?: ImportControl<PreviewProgress>,
  ): Promise<ImportPreview>;
  /** Imports one file in its own worker. Resolves after the lists on screen have reloaded. */
  run(file: File, choices: WizardChoices, control?: ImportControl<ImportProgress>): Promise<ImportResult>;
  /** Takes an import back; resolves after the lists on screen have reloaded. */
  undo(batchId: string): Promise<UndoImportResult>;
}

/** The import use cases for the wizard, bound to the open library. Only call under a screen that opened it. */
export function useImportActions(): ImportActions {
  const { state, refresh } = useLibraryInternals();
  const createTransport = useContext(TransportContext);
  return useMemo(() => {
    const ready = () => {
      if (state.status !== 'ready') throw new Error('the library is not open');
      return state;
    };
    const workerDeps = () => {
      const library = ready();
      return { client: { connectPort: library.import.connectPort }, blobStore: library.deps.blobStore };
    };
    return {
      preview: async (file, choices, control = {}) => {
        const storage = await getDeviceStorageStatus();
        return whileBusy(
          () =>
            previewWhatsAppExportInWorker(workerDeps(), previewRequest(file, choices, storage), {
              workerUrl: ready().import.workerUrl,
              createTransport,
              ...control,
            }),
          control.signal,
        );
      },
      run: async (file, choices, control = {}) => {
        try {
          return await importWhatsAppExportInWorker(workerDeps(), importRequest(file, choices), {
            workerUrl: ready().import.workerUrl,
            createTransport,
            ...control,
          });
        } finally {
          await refresh();
        }
      },
      undo: async (batchId) => {
        try {
          return await undoImportBatch(ready().deps, batchId);
        } finally {
          await refresh();
        }
      },
    };
  }, [state, refresh, createTransport]);
}
