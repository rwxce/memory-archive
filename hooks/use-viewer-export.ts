'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ArchiveError,
  DbError,
  ViewerPackageError,
  exportViewerPackage,
  fetchViewerTemplate,
  type ViewerPackageResult,
  type ViewerSelection,
} from '@/lib/usecases/viewer-package';
import { downloadBlob } from './download-blob';
import { throttleProgress, type PackProgress } from './throttle-progress';
import { useLibraryInternals } from './use-library';

/** Which `backup.viewer.error.*` message explains a failure. */
export type ViewerExportErrorKey = 'dates' | 'notFound' | 'template' | 'missingMedia' | 'damaged' | 'limit' | 'storage' | 'generic';

/** What the screen keeps of a finished copy: never the file itself. */
export type SavedViewerCopy = Pick<ViewerPackageResult, 'fileName' | 'mediaCount' | 'missingMedia'> & { includeMedia: boolean };

export type ViewerExportState =
  | { status: 'idle' }
  | { status: 'working'; progress: PackProgress }
  | { status: 'done'; copy: SavedViewerCopy }
  | { status: 'failed'; error: ViewerExportErrorKey };

export interface ViewerExport {
  state: ViewerExportState;
  /** Builds the package and hands it to the browser; call it from a click. */
  exportViewer(selection: ViewerSelection): Promise<void>;
  reset(): void;
}

/** Maps any failure of the export to the message that explains it. */
export function viewerExportErrorKey(error: unknown): ViewerExportErrorKey {
  if (error instanceof ViewerPackageError) return error.code === 'template-missing' ? 'template' : 'generic';
  if (error instanceof DbError) return error.code === 'invalid' ? 'dates' : error.code === 'not-found' ? 'notFound' : 'generic';
  if (error instanceof ArchiveError) {
    switch (error.code) {
      case 'blob-missing':
        return 'missingMedia';
      case 'integrity':
        return 'damaged';
      case 'limit-exceeded':
        return 'limit';
      case 'storage':
        return 'storage';
      case 'unsafe-path':
        return 'damaged';
      default:
        return 'generic';
    }
  }
  return 'generic';
}

/** "Copy to read on a computer": one at a time, with progress; read-only, so it needs no archive lock. */
export function useViewerExport(): ViewerExport {
  const { state: library } = useLibraryInternals();
  const [state, setState] = useState<ViewerExportState>({ status: 'idle' });
  const busy = useRef(false);

  const exportViewer = useCallback(
    async (selection: ViewerSelection) => {
      if (library.status !== 'ready' || busy.current) return;
      busy.current = true;
      setState({ status: 'working', progress: { phase: 'preparing' } });
      const progress = throttleProgress((p) => setState({ status: 'working', progress: p }));
      try {
        const result = await exportViewerPackage(library.deps, {
          selection,
          loadTemplate: fetchViewerTemplate(process.env.NEXT_PUBLIC_BASE_PATH ?? ''),
          onProgress: (p) => progress(p.phase === 'reading' ? { phase: 'preparing' } : p),
        });
        // Still inside the click's continuation: the browser counts the download as the person's action.
        downloadBlob(result.blob, result.fileName);
        setState({
          status: 'done',
          copy: { fileName: result.fileName, mediaCount: result.mediaCount, missingMedia: result.missingMedia, includeMedia: selection.includeMedia },
        });
      } catch (error) {
        setState({ status: 'failed', error: viewerExportErrorKey(error) });
      } finally {
        busy.current = false;
      }
    },
    [library],
  );

  const reset = useCallback(() => {
    if (!busy.current) setState({ status: 'idle' });
  }, []);

  return { state, exportViewer, reset };
}
