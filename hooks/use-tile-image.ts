'use client';

import { useEffect, useState } from 'react';
import type { PersonMediaItem } from '@/lib/domain/library';
import { readTileImage } from '@/lib/usecases/tile-image';
import { Cancelled, mediaQueue } from './media-queue';
import { useLibraryInternals } from './use-library';
import { failedMedia, type MediaState } from './use-media-url';

/**
 * The picture a gallery tile shows, read only while `near` (the tile is close to the screen): a
 * small cached thumbnail, made on first need, or the full-size file when none can be made. The read
 * (and the one-time thumbnailing) waits in the shared media queue; the URL is revoked when the tile
 * leaves the window or unmounts. The lightbox does not use this: it always opens the full file.
 */
export function useTileImage(item: PersonMediaItem, near: boolean): MediaState {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const { mediaSha256: sha256, mediaMime: mime, mediaName: name } = item;
  const [state, setState] = useState<MediaState>({ status: 'idle' });

  useEffect(() => {
    if (!near) return;
    if (!sha256) {
      setState({ status: 'missing' });
      return;
    }
    if (!deps) return;
    let alive = true;
    let url: string | undefined;
    setState({ status: 'loading' });
    const job = mediaQueue.enqueue(() => readTileImage(deps, { sha256, mime, name }));
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
  }, [deps, near, sha256, mime, name]);

  return near ? state : { status: 'idle' };
}
