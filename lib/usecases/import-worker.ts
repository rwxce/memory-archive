/**
 * Web Worker entry of the import (bundled by `scripts/build-db-worker.mjs` into
 * `public/db/import-worker.js`; started by `createImportWorkerTransport`). Parsing, inflating,
 * hashing and the blob writes happen here, off the page's thread. It never opens SQLite.
 */
import { webArchiveLock } from './archive-guard';
import { openOpfsBlobStore } from '../storage/opfs-blob-store';
import { createImportWorker } from './import-worker-core';
import type { ImportWorkerEvent, ImportWorkerRequest } from './import-protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null;
  postMessage(message: ImportWorkerEvent): void;
};

const worker = createImportWorker({
  post: (event) => scope.postMessage(event),
  openBlobStore: () => openOpfsBlobStore({ sweep: false }),
  ...(typeof navigator !== 'undefined' && 'locks' in navigator ? { lock: webArchiveLock } : {}),
});

scope.onmessage = (event) => worker.handle(event.data);
