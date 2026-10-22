'use client';

import { useEffect, useState, type RefObject } from 'react';

/** How far beyond the screen an element still counts as near: about a screen or two of tiles. */
export const NEAR_MARGIN = '600px 0px';

/**
 * Whether `ref`'s element is on screen or within `margin` of it, for lazy work (reading a photo)
 * that should start just before it is seen and stop when it is far away again. Without an observer
 * (old engines) everything counts as near. When `active` is false no observer is created at all.
 */
export function useNearViewport(ref: RefObject<Element | null>, active = true, margin = NEAR_MARGIN): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setNear(last.isIntersecting);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active, margin]);
  return active && near;
}
