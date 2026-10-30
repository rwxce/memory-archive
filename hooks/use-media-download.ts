'use client';

import { useCallback, useRef, useState } from 'react';
import { readBlob } from '@/lib/usecases/conversation-view';
import { downloadBlob } from './download-blob';
import { failedMedia, type MediaSource } from './use-media-url';
import { useLibraryInternals } from './use-library';

export type MediaDownloadState = 'idle' | 'loading' | 'missing' | 'too-large' | 'error';

/**
 * Save one stored file: `save()` reads it and starts the browser download in the continuation of
 * the click that called it. Nothing is read before that, and nothing is kept afterwards.
 */
export function useMediaDownload(source: MediaSource, fileName: string): { state: MediaDownloadState; save(): Promise<void> } {
  const { state: library } = useLibraryInternals();
  const [state, setState] = useState<MediaDownloadState>('idle');
  const busy = useRef(false);
  const { sha256, mime, name } = source;

  const save = useCallback(async () => {
    if (busy.current) return;
    if (!sha256) {
      setState('missing');
      return;
    }
    if (library.status !== 'ready') return;
    busy.current = true;
    setState('loading');
    try {
      const blob = await readBlob(library.deps, sha256, { mime, name });
      downloadBlob(blob, fileName);
      setState('idle');
    } catch (error) {
      setState(failedMedia(error).status as MediaDownloadState);
    } finally {
      busy.current = false;
    }
  }, [library, sha256, mime, name, fileName]);

  return { state, save };
}
