'use client';

import { useEffect } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * Registers out/sw.js (production builds only: `next dev` has no worker) so
 * the app keeps working offline after the first visit.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(`${basePath}/sw.js`, { scope: `${basePath}/` }).catch(() => {
      // Unsupported or blocked (e.g. private mode): the app still works online.
    });
  }, []);
  return null;
}
