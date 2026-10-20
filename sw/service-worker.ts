/// <reference lib="webworker" />
// Service worker: makes the app work in airplane mode after the first visit,
// and receives files shared to the installed app (Web Share Target).
//
// Built by scripts/build-sw.mjs after `next build`: bundled with esbuild, then
// @serwist/build `injectManifest` replaces `self.__SW_MANIFEST` with every
// file of the static export (out/) and writes out/sw.js.
//
// Caches only the app's own files. Personal data never goes through here
// except shared files, which wait in the share inbox until imported.

import { NetworkOnly, Serwist, type PrecacheEntry } from 'serwist';
import { handleShareTarget, offlinePageFor, SHARE_TARGET_PATH } from './share-target';

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
};

// Replaced at build time (esbuild `define`).
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    // `/en/settings/` → `/en/settings/index.html` in the precache.
    directoryIndex: 'index.html',
    cleanURLs: true,
    // A static export never varies by query string; Next.js adds `?_rsc=<hash>`
    // to client-navigation payloads and `?icon.<hash>` to icon links.
    ignoreURLParametersMatching: [/.*/],
    concurrency: 8,
  },
  // A new version takes over on the next load: the app is static files only.
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  disableDevLogs: true,
});

const scopeUrl = () => self.registration.scope;

// Web Share Target: POST <scope>share-target/ (multipart) from the OS share sheet.
serwist.registerCapture(
  ({ request, url }) => request.method === 'POST' && url.href === new URL(SHARE_TARGET_PATH, scopeUrl()).href,
  ({ request }) => handleShareTarget(request, caches, scopeUrl()),
  'POST',
);

// Next.js checks prefetch targets with HEAD: answer from the precache offline.
serwist.registerCapture(
  ({ request, url }) => request.method === 'HEAD' && url.origin === self.location.origin,
  async ({ request }) => {
    const url = new URL(request.url);
    url.search = '';
    if (url.pathname.endsWith('/')) url.pathname += 'index.html';
    const cached = await serwist.matchPrecache(url.href);
    return cached ? new Response(null, { status: cached.status, headers: cached.headers }) : fetch(request);
  },
  'HEAD',
);

// Anything not precached goes to the network; when that fails (offline),
// navigations get the offline page in their language.
serwist.setDefaultHandler(new NetworkOnly());
serwist.setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate' || request.destination === 'document') {
    const page = await serwist.matchPrecache(offlinePageFor(new URL(request.url).pathname, BASE_PATH));
    if (page) return page;
  }
  return Response.error();
});

serwist.addEventListeners();
