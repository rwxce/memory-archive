import { createDbClient, createPortTransport, type DbClient } from '../db/client';
import { handleDbRequest } from '../db/dispatch';
import { createDbServer } from '../db/serve';
import { openMemoryDb, type OpenedDb } from '../db/open';
import type { DbRequest, DbResponse } from '../db/protocol';
import { openBlobStore, type OpfsDirectoryHandle } from '../storage/opfs-blob-store';
import { createMemoryDirectory } from '../storage/test-opfs-directory';
import { isArchiveBusy } from './archive-guard';
import type { ImportWorkerTransport } from './import-client';
import type { ImportWorkerEvent, ImportWorkerRequest } from './import-protocol';
import { createImportWorker } from './import-worker-core';
import type { Library } from './library';
import type { ProfileDeps } from './profiles';

/**
 * Test helper: a real in-memory database behind the real dispatcher, reached
 * through the real client. Requests and responses go through `structuredClone`,
 * like a Web Worker boundary, so only plain data can pass.
 */
export async function createTestLibrary(): Promise<{ opened: OpenedDb; client: DbClient; deps: ProfileDeps; root: OpfsDirectoryHandle }> {
  const opened = await openMemoryDb();
  const server = createDbServer(async () => opened);
  let respond: (r: DbResponse) => void = () => {};
  const client = createDbClient({
    send: (request) => {
      const response = structuredClone(handleDbRequest(opened, structuredClone(request) as DbRequest));
      queueMicrotask(() => respond(response));
    },
    onResponse: (listener) => (respond = listener),
    onFailure: () => {},
    close: () => {},
    // Like the real worker transport: a port to the same connection, for the import worker.
    connect: () => {
      const channel = new MessageChannel();
      server.handle({ type: 'connect', port: channel.port1 }, () => {});
      return channel.port2;
    },
  });
  let n = 0;
  const root = createMemoryDirectory();
  const blobStore = await openBlobStore(root);
  const deps: ProfileDeps = {
    client,
    blobStore,
    newId: () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`,
    now: () => new Date('2026-03-01T10:00:00Z'),
  };
  return { opened, client, deps, root };
}

/** Test helper: the `Library` a screen test hands to `LibraryProvider`, around existing deps. */
export function libraryOf(deps: ProfileDeps, close: Library['close'] = () => {}): Library {
  return {
    deps,
    cleanup: Promise.resolve(),
    importWorkerUrl: '/db/import-worker.js',
    connectPort: () => (deps.client as DbClient).connectPort(),
    isBusy: () => isArchiveBusy(deps.blobStore),
    close,
  };
}

export interface LoopbackImports {
  /** Pass as `createTransport`: every call is a new worker, like the real one. */
  createTransport: () => ImportWorkerTransport;
  /** The requests every worker received, in order. */
  requests: ImportWorkerRequest[];
  /** Workers started and terminated so far. */
  started: number;
  terminated: number;
  /** Set to make the worker of an import (not a preview) of this file name crash instead of running: the page hears an error. */
  crashStart?: (fileName: string) => boolean;
}

/**
 * Test helper: the page's side of the import worker wired straight to the REAL worker core (the
 * same code the built `import-worker.js` runs), in this thread, against the library's own blob
 * directory. Events cross `structuredClone` like a Worker boundary; the request does not (it
 * carries a `Blob`, which a DOM test environment may not clone), the database port is used as is.
 * `holdMedia`: the first media file is not stored until it resolves; `holdSave`: the database save
 * (`importMessages`) does not start until it resolves, with the `saving` progress already sent. So a
 * test can act mid-import (cancel, read the progress).
 */
export function createLoopbackImports(
  root: OpfsDirectoryHandle,
  options: { holdMedia?: Promise<void>; holdSave?: Promise<void> } = {},
): LoopbackImports {
  const loopback: LoopbackImports = {
    requests: [],
    started: 0,
    terminated: 0,
    createTransport() {
      loopback.started++;
      let listener: (event: ImportWorkerEvent) => void = () => {};
      let failure: (message: string) => void = () => {};
      let dead = false;
      let puts = 0;
      const worker = createImportWorker({
        createDbClient: (port) => {
          const real = createDbClient(createPortTransport(port));
          if (!options.holdSave) return real;
          return {
            ...real,
            call: async (op: never, ...args: never[]) => {
              if (op === 'importMessages') await options.holdSave;
              return (real.call as (...a: unknown[]) => Promise<unknown>)(op, ...args);
            },
          } as DbClient;
        },
        post: (event) => {
          const copy = structuredClone(event);
          setTimeout(() => !dead && listener(copy));
        },
        openBlobStore: async () => {
          const real = await openBlobStore(root, { sweep: false });
          return {
            ...real,
            put: async (source) => {
              if (++puts === 1) await options.holdMedia;
              return real.put(source);
            },
          };
        },
      });
      return {
        post(message) {
          loopback.requests.push(message);
          if (message.type === 'start' && loopback.crashStart?.(message.input.fileName)) {
            setTimeout(() => failure('the import worker crashed'));
            return;
          }
          setTimeout(() => worker.handle(message));
        },
        onMessage: (l) => (listener = l),
        onFailure: (l) => (failure = l),
        terminate() {
          loopback.terminated++;
          dead = true;
          worker.handle({ type: 'cancel' });
        },
      };
    },
  };
  return loopback;
}
