/**
 * Web Worker entry: owns the OPFS-persisted SQLite database and answers
 * `DbRequest` messages with `DbResponse` messages. Started by
 * `createWorkerTransport()` in `client.ts`; the app never talks to SQLite
 * from the main thread. A `connect` message adds a port for another worker
 * (see `serve.ts`).
 */
import { openOpfsDb } from './open';
import { createDbServer, type DbWorkerMessage } from './serve';
import type { DbResponse } from './protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DbWorkerMessage>) => void) | null;
  postMessage(message: DbResponse): void;
};

const server = createDbServer(openOpfsDb);

scope.onmessage = (event) => server.handle(event.data, (response) => scope.postMessage(response));
