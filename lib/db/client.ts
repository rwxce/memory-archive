import { DbError, fromDbErrorData } from './errors';
import type { DbOpName, DbOps, DbRequest, DbResponse } from './protocol';

/**
 * Typed, promise-based client for the database worker. Each call carries a
 * unique id; the response with the same id settles it, in any order.
 */
export interface DbTransport {
  send(request: DbRequest): void;
  /** Register the single response listener. */
  onResponse(listener: (response: DbResponse) => void): void;
  /** Register the single failure listener (worker crashed or failed to load). */
  onFailure(listener: (message: string) => void): void;
  close(): void;
}

type CallArgs<K extends DbOpName> = undefined extends DbOps[K]['params']
  ? [params?: DbOps[K]['params']]
  : [params: DbOps[K]['params']];

export interface DbClient {
  call<K extends DbOpName>(op: K, ...args: CallArgs<K>): Promise<DbOps[K]['result']>;
  /** Stops the worker; pending and later calls reject with `closed`. */
  close(): void;
}

export function createDbClient(transport: DbTransport): DbClient {
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: DbError) => void }>();
  let nextId = 1;
  let failure: DbError | undefined;

  const failAll = (error: DbError) => {
    failure ??= error;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
  };

  transport.onResponse((response) => {
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result as never);
    else entry.reject(fromDbErrorData(response.error));
  });
  transport.onFailure((message) => failAll(new DbError('unavailable', message)));

  return {
    call: (op, ...args) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          transport.send({ id, op, params: args[0] } as DbRequest);
        } catch (error) {
          pending.delete(id);
          throw error;
        }
      }),
    close: () => {
      failAll(new DbError('closed', 'the database connection was closed'));
      transport.close();
    },
  };
}

/**
 * Starts the real worker (browser only) from its built URL, e.g.
 * `${basePath}/db/worker.js`: `scripts/build-db-worker.mjs` bundles it into
 * `public/db/`. The URL is a parameter because `lib/` cannot read the
 * deployment base path itself.
 */
export function createWorkerTransport(workerUrl: string | URL): DbTransport {
  const worker = new Worker(workerUrl, { type: 'module' });
  return {
    send: (request) => worker.postMessage(request),
    onResponse: (listener) => {
      worker.onmessage = (event: MessageEvent<DbResponse>) => listener(event.data);
    },
    onFailure: (listener) => {
      worker.onerror = (event) => listener(event.message || 'the database worker failed to start');
      worker.onmessageerror = () => listener('the database worker sent an unreadable message');
    },
    close: () => worker.terminate(),
  };
}
