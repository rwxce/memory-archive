import { createDbClient, createPortTransport, type DbClient } from '../db/client';
import type { BlobStore } from '../storage/blob-store';
import type { ArchiveLock } from './archive-guard';
import { importWhatsAppExport } from './import';
import { previewWhatsAppExport } from './import-preview';
import { toImportFailure, type ImportWorkerEvent, type ImportWorkerRequest } from './import-protocol';

/**
 * What the import worker does (an import or a preview, one job per worker), without `self`: so
 * tests run it against a real in-memory database and blob store. The entry (`import-worker.ts`) plugs in the browser pieces.
 *
 * The worker never opens SQLite: its database client talks through the port the page brokered to
 * the database worker. It takes the cross-tab archive lock itself (`lock`) for an import, so while
 * it runs the page cannot start a restore or undo; a preview takes no lock and opens no blob store.
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

  /** Runs one job over a database client on the brokered port; the client is closed at the end. */
  async function run(dbPort: MessagePort, job: (client: DbClient) => Promise<void>): Promise<void> {
    let client: DbClient | undefined;
    try {
      // Inside the try: a missing or broken port is a typed error to the page, not a silent hang.
      client = (env.createDbClient ?? ((port) => createDbClient(createPortTransport(port))))(dbPort);
      await job(client);
    } catch (error) {
      env.post({ type: 'error', error: toImportFailure(error) });
    } finally {
      client?.close();
    }
  }

  const startImport = (request: Extract<ImportWorkerRequest, { type: 'start' }>, signal: AbortSignal) =>
    run(request.dbPort, async (client) => {
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
    });

  // No blob store is opened and no lock is taken: a preview only reads.
  const startPreview = (request: Extract<ImportWorkerRequest, { type: 'preview' }>, signal: AbortSignal) =>
    run(request.dbPort, async (client) => {
      const result = await previewWhatsAppExport({ client }, request.input, {
        signal,
        onProgress: (progress) => env.post({ type: 'preview-progress', progress }),
      });
      env.post({ type: 'preview-done', result });
    });

  return {
    handle(request) {
      if (request.type === 'cancel') {
        controller?.abort();
        return;
      }
      if (controller) {
        env.post({ type: 'error', error: { kind: 'internal', message: 'an import worker runs one job' } });
        return;
      }
      // Created before the first await, so a `cancel` that follows at once always finds it.
      controller = new AbortController();
      if (request.type === 'start') void startImport(request, controller.signal);
      else void startPreview(request, controller.signal);
    },
  };
}
