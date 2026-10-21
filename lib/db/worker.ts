/**
 * Web Worker entry: owns the OPFS-persisted SQLite database and answers
 * `DbRequest` messages with `DbResponse` messages. Started by
 * `createWorkerTransport()` in `client.ts`; the app never talks to SQLite
 * from the main thread.
 *
 * The database opens on the first request. If that fails (no OPFS, another tab
 * holds it) every request gets the error, and the next request retries.
 */
import { toDbError } from './errors';
import { handleDbRequest } from './dispatch';
import { openOpfsDb, type OpenedDb } from './open';
import type { DbRequest, DbResponse } from './protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DbRequest>) => void) | null;
  postMessage(message: DbResponse): void;
};

let opening: Promise<OpenedDb> | undefined;

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    opening ??= openOpfsDb();
    const opened = await opening;
    scope.postMessage(handleDbRequest(opened, request));
  } catch (error) {
    opening = undefined;
    scope.postMessage({ id: request.id, ok: false, error: toDbError(error).toJSON() });
  }
};
