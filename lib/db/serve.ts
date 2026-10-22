import { toDbError } from './errors';
import { handleDbRequest } from './dispatch';
import type { OpenedDb } from './open';
import type { DbRequest, DbResponse } from './protocol';

/**
 * What the database worker receives: a request, or a `connect` carrying a `MessagePort`. The
 * port lets ANOTHER worker (the import worker) talk to this same connection: SQLite lives here
 * (the SAH-pool VFS allows one connection), so the import never opens a second one. The page
 * brokers the `MessageChannel`: one end here, the other end in the import worker.
 */
export type DbWorkerMessage = DbRequest | { type: 'connect'; port: MessagePort };

export interface DbServer {
  /** Answers a request through `reply`, or starts serving a connected port. Never throws. */
  handle(message: DbWorkerMessage, reply: (response: DbResponse) => void): void;
}

/**
 * The request loop of the database worker, separate from `self` so it can be tested with real
 * `MessageChannel`s. The database opens on the first request. If that fails every request gets
 * the error, and the next request retries. Requests from all ports run one at a time (opening
 * is shared, each handler is synchronous), so a connected worker and the page never interleave
 * inside a transaction.
 */
export function createDbServer(open: () => Promise<OpenedDb>): DbServer {
  let opening: Promise<OpenedDb> | undefined;
  // One request at a time, even when a handler is async (`restoreDatabase`): no other request,
  // from the page or the import worker, runs between its awaits.
  let tail: Promise<void> = Promise.resolve();

  async function answer(request: DbRequest, reply: (response: DbResponse) => void): Promise<void> {
    try {
      opening ??= open();
      const opened = await opening;
      reply(await handleDbRequest(opened, request));
    } catch (error) {
      opening = undefined;
      reply({ id: request.id, ok: false, error: toDbError(error).toJSON() });
    }
  }

  function enqueue(request: DbRequest, reply: (response: DbResponse) => void): void {
    tail = tail.then(() => answer(request, reply));
  }

  return {
    handle(message, reply) {
      if ('type' in message && message.type === 'connect') {
        const { port } = message;
        port.onmessage = (event: MessageEvent<DbRequest>) => enqueue(event.data, (response) => port.postMessage(response));
        return;
      }
      enqueue(message as DbRequest, reply);
    },
  };
}
