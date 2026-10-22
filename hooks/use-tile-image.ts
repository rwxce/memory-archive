'use client';

import type { PersonMediaItem } from '@/lib/domain/library';
import { useMediaUrl, type MediaState } from './use-media-url';

/**
 * The picture a gallery tile shows, read only while `near` (the tile is close to the screen). Today
 * it is the full-size file through the shared read queue; the URL is revoked when the tile leaves
 * the window or unmounts. This is the one seam where thumbnails will replace the source.
 */
export function useTileImage(item: PersonMediaItem, near: boolean): MediaState {
  return useMediaUrl({ sha256: item.mediaSha256, mime: item.mediaMime, name: item.mediaName }, near);
}
