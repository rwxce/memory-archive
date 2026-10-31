'use client';

import { useEffect, useState } from 'react';
import type { PhotoPicture } from '@/lib/domain/photo';
import { readPhotoFile, readPhotoTile } from '@/lib/usecases/photo-assign';
import { Cancelled, mediaQueue } from './media-queue';
import { useLibraryInternals } from './use-library';
import { failedMedia, type MediaState } from './use-media-url';

/** `no-preview`: a tile with nothing small to show (see `usePhotoImage`). */
export type PhotoImageState = MediaState | { status: 'no-preview' };

/**
 * A picture of the collection as an object URL. `size: 'tile'` reads the small cached thumbnail (a video's tile
 * reads nothing, and neither does a photo that has no thumbnail and is too big to show as it is: both say `no-preview`
 * and the tile shows a placeholder, so a tile never decodes a full-size picture), `'full'` the file. Read only while `enabled`; the read waits in the shared
 * media queue and is dropped if the tile goes away first; the URL is revoked when `enabled` turns off, the picture
 * changes or the component unmounts, so scrolling never piles up what it showed.
 */
export function usePhotoImage(picture: Pick<PhotoPicture, 'sha256' | 'kind'>, size: 'tile' | 'full', enabled: boolean): PhotoImageState {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const { sha256, kind } = picture;
  const skip = size === 'tile' && kind === 'video';
  const [state, setState] = useState<PhotoImageState>({ status: 'idle' });

  useEffect(() => {
    if (!enabled || skip || !deps) return;
    let alive = true;
    let url: string | undefined;
    setState({ status: 'loading' });
    // The picture the person opened is not made to wait behind a row of tile reads.
    const job = mediaQueue.enqueue(() => (size === 'tile' ? readPhotoTile(deps, sha256) : readPhotoFile(deps, sha256)), size === 'full' ? { priority: 'high' } : {});
    job.promise.then(
      (blob) => {
        if (!alive) return;
        if (!blob) {
          setState({ status: 'no-preview' });
          return;
        }
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
  }, [deps, enabled, skip, size, sha256]);

  return enabled && !skip ? state : { status: 'idle' };
}
