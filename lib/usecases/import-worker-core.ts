import { createDbClient, createPortTransport, type DbClient } from '../db/client';
import type { BlobStore } from '../storage/blob-store';
import type { ArchiveLock } from './archive-guard';
import { importWhatsAppExport } from './import';
import { toImportFailure, type ImportWorkerEvent, type ImportWorkerRequest } from './import-protocol';

/**
 * What the import worker does, without `self`: so tests run it against a real in-memory database
 * and blob store. The entry (`import-worker.ts`) plugs in the browser pieces.
 *
 * The worker never opens SQLite: its database client talks through the port the page brokered to
 * the database worker. It takes the cross-tab archive lock itself (`lock`), so while it runs the
 * page cannot start a restore or undo.
 */
export interface ImportWorkerEnv {
  post(event: ImportWorkerEvent): void;
  /** Opens the blob store WITHOUT sweeping `tmp/` (the page owns the sweep). */
  openBlobStore(): Promise<BlobStore>;
  lock?: ArchiveLock;
  /** The database client over the brokered port. */
  createDbClient?: (port: MessagePort) => DbClient;
}

export function createImportWorker(env: ImportWorkerEnv): { handle(request: ImportWorkerRequest): void } {
  let controller: AbortController | undefined;

  async function start(request: Extract<ImportWorkerRequest, { type: 'start' }>, signal: AbortSignal): Promise<void> {
    let client: DbClient | undefined;
    try {
      // Inside the try: a missing or broken port is a typed error to the page, not a silent hang.
      client = (env.createDbClient ?? ((port) => createDbClient(createPortTransport(port))))(request.dbPort);
      const blobStore = await env.openBlobStore();
      const result = await importWhatsAppExport(
        { client, blobStore, ...(env.lock ? { lock: env.lock } : {}) },
        {
          ...request.input,
          signal,
          onProgress: (progress) => env.post({ type: 'progress', progress }),
        },
      );
      env.post({ type: 'done', result });
    } catch (error) {
      env.post({ type: 'error', error: toImportFailure(error) });
    } finally {
      client?.close();
    }
  }

  return {
    handle(request) {
      if (request.type === 'cancel') {
        controller?.abort();
        return;
      }
      if (controller) {
        env.post({ type: 'error', error: { kind: 'internal', message: 'an import worker runs one import' } });
        return;
      }
      // Created before the first await, so a `cancel` that follows at once always finds it.
      controller = new AbortController();
      void start(request, controller.signal);
    },
  };
}
