'use client';

import { useEffect, useState } from 'react';
import { blobSize } from '@/lib/usecases/conversation-media';
import { readBlob } from '@/lib/usecases/conversation-view';
import { Cancelled, mediaQueue } from './media-queue';
import { useLibraryInternals } from './use-library';

export interface MediaSource {
  sha256: string | null;
  mime?: string | null;
  name?: string;
}

export type MediaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; size: number }
  /** The message expects a file the archive does not have. */
  | { status: 'missing' }
  /** Too big to load on this device's storage path; the message says so instead of failing. */
  | { status: 'too-large' }
  | { status: 'error' };

/** The state a failed read maps to. */
export function failedMedia(error: unknown): MediaState {
  const code = (error as { code?: string }).code;
  return { status: code === 'not-found' ? 'missing' : code === 'too-large' ? 'too-large' : 'error' };
}

/**
 * The bytes of one message's file as an object URL, read when `enabled` and not before. The
 * read waits in the shared queue (a few at a time), is dropped if the row goes away first, and
 * the URL is revoked when the row unmounts or the file changes, so scrolling through a
 * conversation never accumulates what it showed. A missing file is its own state, not an error.
 */
export function useMediaUrl(source: MediaSource, enabled = true): MediaState {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const { sha256, mime, name } = source;
  const [state, setState] = useState<MediaState>({ status: 'idle' });

  useEffect(() => {
    if (!enabled) return;
    if (!sha256) {
      setState({ status: 'missing' });
      return;
    }
    if (!deps) return;
    let alive = true;
    let url: string | undefined;
    setState({ status: 'loading' });
    const job = mediaQueue.enqueue(() => readBlob(deps, sha256, { mime, name }));
    job.promise.then(
      (blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url, size: blob.size });
      },
      (error: unknown) => {
        if (!alive || error instanceof Cancelled) return;
        setState(failedMedia(error));
      },
    );
    return () => {
      alive = false;
      job.cancel();
      if (url) URL.revokeObjectURL(url);
    };
  }, [deps, enabled, sha256, mime, name]);

  return enabled ? state : { status: 'idle' };
}

/** Size of a stored file without reading it; `undefined` while unknown or when it is missing. */
export function useBlobSize(sha256: string | null): number | undefined {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [size, setSize] = useState<number>();
  useEffect(() => {
    if (!deps || !sha256) return;
    let alive = true;
    blobSize(deps, sha256).then(
      (value) => alive && setSize(value),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [deps, sha256]);
  return size;
}
