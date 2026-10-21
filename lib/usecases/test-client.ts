import { createDbClient, type DbClient } from '../db/client';
import { handleDbRequest } from '../db/dispatch';
import { createDbServer } from '../db/serve';
import { openMemoryDb, type OpenedDb } from '../db/open';
import type { DbRequest, DbResponse } from '../db/protocol';
import { openBlobStore, type OpfsDirectoryHandle } from '../storage/opfs-blob-store';
import { createMemoryDirectory } from '../storage/test-opfs-directory';
import { isArchiveBusy } from './archive-guard';
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
