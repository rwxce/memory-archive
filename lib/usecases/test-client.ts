import { createDbClient, type DbClient } from '../db/client';
import { handleDbRequest } from '../db/dispatch';
import { openMemoryDb, type OpenedDb } from '../db/open';
import type { DbRequest, DbResponse } from '../db/protocol';
import { openBlobStore } from '../storage/opfs-blob-store';
import { createMemoryDirectory } from '../storage/test-opfs-directory';
import type { ProfileDeps } from './profiles';

/**
 * Test helper: a real in-memory database behind the real dispatcher, reached
 * through the real client. Requests and responses go through `structuredClone`,
 * like a Web Worker boundary, so only plain data can pass.
 */
export async function createTestLibrary(): Promise<{ opened: OpenedDb; client: DbClient; deps: ProfileDeps }> {
  const opened = await openMemoryDb();
  let respond: (r: DbResponse) => void = () => {};
  const client = createDbClient({
    send: (request) => {
      const response = structuredClone(handleDbRequest(opened, structuredClone(request) as DbRequest));
      queueMicrotask(() => respond(response));
    },
    onResponse: (listener) => (respond = listener),
    onFailure: () => {},
    close: () => {},
  });
  let n = 0;
  const blobStore = await openBlobStore(createMemoryDirectory());
  const deps: ProfileDeps = {
    client,
    blobStore,
    newId: () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`,
    now: () => new Date('2026-03-01T10:00:00Z'),
  };
  return { opened, client, deps };
}
