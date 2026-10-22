'use client';

import { useEffect, useRef, useState } from 'react';
import type { PersonMediaItem } from '@/lib/domain/library';
import { readBlob } from '@/lib/usecases/conversation-view';
import { Cancelled, mediaQueue } from './media-queue';
import type { MediaState } from './use-media-url';
import { useLibraryInternals } from './use-library';

type Entry = Exclude<MediaState, { status: 'idle' }>;

const whenIdle = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 200);
  return () => clearTimeout(id);
};

/**
 * The full-size file of the item open in the lightbox as an object URL. Only that item and, once
 * the browser is idle, the next one if it is a photo are held; every other URL is revoked as the
 * viewer moves on, and all of them when it closes. A missing file is its own state, not an error.
 */
export function useLightboxMedia(current: PersonMediaItem, next: PersonMediaItem | undefined): MediaState {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [entries, setEntries] = useState<Record<number, Entry>>({});
  const urls = useRef(new Map<number, string>());
  const preload = next && next.type === 'photo' ? next : undefined;
  const currentId = current.id;
  const preloadId = preload?.id;

  // Everything is freed when the viewer closes (and, in development, between the double mounts).
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
      setEntries({});
    };
  }, []);

  useEffect(() => {
    if (!deps) return;
    const keep = new Set<number>([currentId, ...(preloadId === undefined ? [] : [preloadId])]);
    for (const [id, url] of urls.current) {
      if (keep.has(id)) continue;
      URL.revokeObjectURL(url);
      urls.current.delete(id);
    }
    setEntries((prev) => {
      const ids = Object.keys(prev).map(Number);
      if (ids.every((id) => keep.has(id))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([id]) => keep.has(Number(id))));
    });

    let alive = true;
    const cancels: Array<() => void> = [];
    const read = (item: PersonMediaItem) => {
      if (urls.current.has(item.id)) return;
      const set = (entry: Entry) => alive && setEntries((prev) => ({ ...prev, [item.id]: entry }));
      set({ status: 'loading' });
      const job = mediaQueue.enqueue(() => readBlob(deps, item.mediaSha256, { mime: item.mediaMime, name: item.mediaName }));
      cancels.push(job.cancel);
      job.promise.then(
        (blob) => {
          if (!alive) return;
          const url = URL.createObjectURL(blob);
          urls.current.set(item.id, url);
          set({ status: 'ready', url, size: blob.size });
        },
        (error: unknown) => {
          if (error instanceof Cancelled) return;
          set({ status: (error as { code?: string }).code === 'not-found' ? 'missing' : 'error' });
        },
      );
    };
    read(current);
    if (preload) cancels.push(whenIdle(() => alive && read(preload)));
    return () => {
      alive = false;
      for (const cancel of cancels) cancel();
    };
    // `current` / `preload` are identified by their ids; the rows themselves do not change.
  }, [deps, currentId, preloadId]);

  return entries[currentId] ?? { status: 'loading' };
}
