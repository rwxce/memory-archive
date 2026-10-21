import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDbClient, createPortTransport, type DbClient } from '../db/client';
import type { OpenedDb } from '../db/open';
import type { BlobStore } from '../storage/blob-store';
import { openBlobStore } from '../storage/opfs-blob-store';
import { undoImportBatch, sweepOrphanBlobs, type ImportProgress, type ImportResult } from './import';
import { ARCHIVE_LOCK_NAME, type ArchiveLock } from './archive-guard';
import { importWhatsAppExportInWorker, type ImportWorkerTransport } from './import-client';
import type { ImportWorkerEvent, ImportWorkerInput, ImportWorkerRequest } from './import-protocol';
import { createImportWorker } from './import-worker-core';
import { createProfile } from './profiles';
import { createTestLibrary } from './test-client';

const bytes = (seed: number, size = 300) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const PHOTO2 = '00000002-PHOTO-2026-03-18-09-05-00.jpg';
const LINES = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: ok',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  `[18/03/2026, 09:05:00] Bo: <attached: ${PHOTO2}>`,
  '[18/03/2026, 09:10:00] Bo: Hola',
];
const zipOf = (lines = LINES) =>
  new Blob([zipSync({ '_chat.txt': strToU8(lines.join('\n')), [PHOTO]: bytes(1), [PHOTO2]: bytes(2) }) as BlobPart]);

function openGate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, open: (afterMs: number) => void setTimeout(release, afterMs) };
}

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;

/** Cross-tab lock simulation: one holder per name, `ifAvailable` semantics. */
function createLock(): ArchiveLock & { hold(): () => void } {
  const held = new Set<string>();
  const lock = (async (name, work) => {
    if (held.has(name)) return { held: false } as const;
    held.add(name);
    try {
      return { held: true, value: await work() } as const;
    } finally {
      held.delete(name);
    }
  }) as ArchiveLock & { hold(): () => void };
  lock.hold = () => {
    held.add(ARCHIVE_LOCK_NAME);
    return () => held.delete(ARCHIVE_LOCK_NAME);
  };
  return lock;
}

interface Loopback extends ImportWorkerTransport {
  requests: ImportWorkerRequest[];
  terminated: number;
  /** COOPERATIVE crash: the worker is told to stop (its `finally` runs and cleans up), the page hears an error. */
  crash(message?: string): void;
  /**
   * HARD kill (process killed, OOM): the worker is frozen where it stands, nothing in it ever runs
   * again (no abort, no `finally`, no cleanup), its pending requests are not answered, and the
   * page only hears an error. Requests it already sent still reach the database worker.
   */
  kill(message?: string): void;
  /** Closes the database ports the frozen worker left open (a real kill frees them). */
  releasePorts(): void;
}

/**
 * The page's transport wired straight to the REAL import worker core. Messages go through
 * `structuredClone` (ports transferred), like a Worker boundary. The worker opens its own blob
 * store on the same directory with `sweep:false`, and reaches the database through the port the
 * client brokered.
 */
function loopback(
  lib: Lib,
  options: { lock?: ArchiveLock; ignoreCancel?: boolean; gate?: Promise<void>; dbGate?: Promise<void>; killWhenSaving?: boolean } = {},
): Loopback {
  let listener: (e: ImportWorkerEvent) => void = () => {};
  let failure: (message: string) => void = () => {};
  let dead = false;
  let frozen = false;
  const ports: MessagePort[] = [];
  const forever = () => new Promise<never>(() => {});
  const worker = createImportWorker({
    createDbClient: (port): DbClient => {
      ports.push(port);
      const real = createDbClient(createPortTransport(port));
      return {
        ...real,
        call: async (op: never, ...args: never[]) => {
          if (frozen) return forever();
          if (op === 'importMessages') {
            if (options.killWhenSaving) {
              // The request is on its way to the database worker; the process dies before the answer.
              (real.call as (...a: unknown[]) => Promise<unknown>)(op, ...args).catch(() => undefined);
              t.kill();
              return forever();
            }
            await options.dbGate;
          }
          return (real.call as (...a: unknown[]) => Promise<unknown>)(op, ...args);
        },
      } as DbClient;
    },
    post: (event) => {
      const copy = structuredClone(event);
      setTimeout(() => !dead && listener(copy));
    },
    openBlobStore: async (): Promise<BlobStore> => {
      const real = await openBlobStore(lib.root, { sweep: false });
      let puts = 0;
      // The second file waits for the gate: the test acts while the worker is in the middle of the media.
      return {
        ...real,
        put: async (source) => {
          if (frozen) return forever();
          if (++puts === 2) await options.gate;
          return frozen ? forever() : real.put(source);
        },
      };
    },
    ...(options.lock ? { lock: options.lock } : {}),
  });
  const t: Loopback = {
    requests: [],
    terminated: 0,
    post(message, transfer) {
      t.requests.push(message);
      if (message.type === 'cancel' && options.ignoreCancel) return;
      const copy = structuredClone(message, { transfer });
      setTimeout(() => worker.handle(copy));
    },
    onMessage: (l) => (listener = l),
    onFailure: (l) => (failure = l),
    terminate() {
      t.terminated++;
      dead = true;
      worker.handle({ type: 'cancel' }); // a terminated worker stops running
    },
    crash(message = 'worker crashed') {
      dead = true;
      worker.handle({ type: 'cancel' });
      setTimeout(() => failure(message));
    },
    kill(message = 'worker killed') {
      dead = true;
      frozen = true;
      setTimeout(() => failure(message));
    },
    releasePorts: () => ports.forEach((port) => port.close()),
  };
  return t;
}

async function setup(lockOptions: { lock?: ArchiveLock } = {}) {
  const lib = await createTestLibrary();
  const profile = await createProfile(lib.deps, { displayName: 'Ana' });
  const lock = lockOptions.lock;
  const input = (zip: Blob = zipOf(), extra: Partial<ImportWorkerInput> = {}): ImportWorkerInput => ({
    zip,
    fileName: 'WhatsApp Chat - Ana i Bo.zip',
    profileIds: [profile.id],
    meAuthor: 'Ana',
    ...extra,
  });
  const run = (
    zip: Blob = zipOf(),
    options: { signal?: AbortSignal; onProgress?: (p: ImportProgress) => void; transport?: Loopback; extra?: Partial<ImportWorkerInput>; cancelGraceMs?: number } = {},
  ) => {
    const transport = options.transport ?? loopback(lib, { lock });
    return importWhatsAppExportInWorker({ client: lib.client, blobStore: lib.deps.blobStore }, input(zip, options.extra), {
      workerUrl: 'unused',
      createTransport: () => transport,
      signal: options.signal,
      onProgress: options.onProgress,
      cancelGraceMs: options.cancelGraceMs,
    });
  };
  return { ...lib, profile, run, lock, input };
}

const tableState = (opened: OpenedDb) =>
  JSON.stringify(
    opened.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((t) => [t.name, opened.db.all(`SELECT * FROM "${t.name}" ORDER BY rowid`)]),
  );

async function imported(result: Promise<ImportResult>) {
  const r = await result;
  if (r.status !== 'imported') throw new Error(`expected an import, got ${r.status}`);
  return r;
}

describe('importWhatsAppExportInWorker', () => {
  test('imports through the worker and the brokered port: messages, media, summary', async () => {
    const lib = await setup();
    const transport = loopback(lib);
    const result = await imported(lib.run(zipOf(), { transport }));
    expect(result.summary).toMatchObject({ added: 5, mediaAdded: 2, alreadyThere: 0 });
    expect(await lib.client.call('listMessages', { conversationId: result.conversationId, limit: 100 })).toHaveLength(5);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
    expect(transport.terminated).toBe(1);
    // The worker was started with a transferred database port and the request, nothing else.
    const start = transport.requests[0];
    expect(start.type).toBe('start');
  });

  test('progress arrives in order: reading, media (by files and bytes), saving, and nothing after the result', async () => {
    const lib = await setup();
    const events: ImportProgress[] = [];
    await imported(lib.run(zipOf(), { onProgress: (p) => events.push(p) }));
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('reading');
    expect(phases.at(-1)).toBe('saving');
    const order = ['reading', 'media', 'saving'];
    expect(phases.map((p) => order.indexOf(p))).toEqual([...phases.map((p) => order.indexOf(p))].sort());
    const media = events.filter((e) => e.phase === 'media');
    expect(media.at(-1)).toMatchObject({ done: 2, total: 2, bytes: 600, totalBytes: 600 });
    expect(media.map((m) => m.done)).toEqual([...media.map((m) => m.done)].sort());
    expect(media.every((m) => (m.bytes ?? 0) <= (m.totalBytes ?? 0))).toBe(true);
    const seen = events.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(seen);
  });

  test('the same ZIP again adds nothing (idempotent through the worker too)', async () => {
    const lib = await setup();
    await imported(lib.run());
    const before = await lib.deps.blobStore.list();
    const again = await imported(lib.run());
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 5, mediaAdded: 0 });
    expect(await lib.deps.blobStore.list()).toEqual(before);
  });

  test('a COOPERATIVE cancel in the middle of the media leaves tables and store exactly as they were', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const controller = new AbortController();
    const gate = openGate();
    const transport = loopback(lib, { gate: gate.promise });
    await expect(
      lib.run(zipOf(), {
        transport,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 1) {
            controller.abort();
            gate.open(10);
          }
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tableState(lib.opened)).toBe(before);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect(transport.requests.map((r) => r.type)).toEqual(['start', 'cancel']);
    expect(transport.terminated).toBe(1);
    // The guard is released: the same file imports afterwards.
    expect((await imported(lib.run())).summary.added).toBe(5);
  });

  test('a signal that is already aborted never starts a worker', async () => {
    const lib = await setup();
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    let created = 0;
    await expect(
      importWhatsAppExportInWorker({ client: lib.client, blobStore: lib.deps.blobStore }, lib.input(), {
        workerUrl: 'unused',
        signal: controller.signal,
        createTransport: () => (created++, loopback(lib)),
      }),
    ).rejects.toThrow('nope');
    expect(created).toBe(0);
  });

  test('a COOPERATIVE crash (the worker cleans up): typed worker-failed error, archive unchanged, import works again', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const gate = openGate();
    const transport = loopback(lib, { gate: gate.promise });
    await expect(
      lib.run(zipOf(), {
        transport,
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 1) {
            transport.crash('boom');
            gate.open(10);
          }
        },
      }),
    ).rejects.toMatchObject({
      name: 'ImportError',
      code: 'worker-failed',
      message: 'boom',
    });
    expect(tableState(lib.opened)).toBe(before);
    // A killed worker cannot clean up: whatever it wrote is an orphan the sweep removes.
    await lib.deps.blobStore.put(bytes(9));
    expect((await sweepOrphanBlobs(lib.deps)).removed).toBeGreaterThanOrEqual(1);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    expect((await imported(lib.run())).summary.added).toBe(5);
  });

  test('a worker that cannot load is worker-failed too (cooperative)', async () => {
    const lib = await setup();
    const transport = loopback(lib);
    const post = transport.post.bind(transport);
    transport.post = (message, transfer) => {
      post(message, transfer);
      transport.crash('the import worker failed to start');
    };
    await expect(lib.run(zipOf(), { transport })).rejects.toMatchObject({ code: 'worker-failed' });
  });

  test('a worker that ignores the cancel is terminated after the grace period (cooperative loopback)', async () => {
    const lib = await setup();
    const controller = new AbortController();
    const gate = openGate();
    const transport = loopback(lib, { ignoreCancel: true, gate: gate.promise });
    await expect(
      lib.run(zipOf(), {
        transport,
        signal: controller.signal,
        cancelGraceMs: 20,
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 1) {
            controller.abort();
            gate.open(200); // the worker would carry on: it never saw the cancel
          }
        },
      }),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'worker-failed' });
    expect(transport.terminated).toBe(1);
  });

  test('typed errors keep their class and code across the boundary', async () => {
    const lib = await setup();
    await expect(lib.run(new Blob(['not a zip']))).rejects.toMatchObject({ name: 'ImportError', code: 'invalid-export' });
    await expect(lib.run(zipOf(), { extra: { meAuthor: 'Nobody' } })).rejects.toMatchObject({ name: 'ImportError', code: 'unknown-author' });
    await expect(
      lib.run(zipOf(), { extra: { conversation: { mode: 'existing', conversationId: '00000000-0000-4000-8000-0000000000ff' } } }),
    ).rejects.toMatchObject({ name: 'DbError', code: 'not-found' });
    await expect(lib.run(zipOf(), { extra: { limits: { maxEntries: 1 } } })).rejects.toMatchObject({ code: 'limit-exceeded' });
    // An ambiguous result is a result, not an error.
    await imported(lib.run());
    const second = await lib.run(zipOf(LINES.slice(0, 2)), { extra: { conversation: { mode: 'new' }, fileName: 'WhatsApp Chat - Ana i Bo.zip' } });
    expect(second.status).toBe('imported');
  });

  test('busy: the page refuses a second import and an undo while one runs; the worker holds the cross-tab lock', async () => {
    const lock = createLock();
    const lib = await setup({ lock });
    const deps = { ...lib.deps, lock };
    const first = lib.run();
    await expect(lib.run()).rejects.toMatchObject({ name: 'ArchiveError', code: 'busy' });
    await expect(undoImportBatch(deps, '00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({ code: 'busy' });
    expect((await imported(first)).summary.added).toBe(5);
    // Another tab holds the lock: the WORKER finds it taken and the typed error comes back.
    const release = lock.hold();
    await expect(lib.run()).rejects.toMatchObject({ name: 'ArchiveError', code: 'busy' });
    release();
    expect((await lib.run()).status).toBe('imported');
  });

  test('an import already running in a worker takes the cross-tab lock, so a page undo gets busy', async () => {
    const lock = createLock();
    const lib = await setup({ lock });
    const gate = openGate();
    let undoResult: Promise<unknown> | undefined;
    await imported(
      lib.run(zipOf(), {
        transport: loopback(lib, { lock, gate: gate.promise }),
        onProgress: (p) => {
          if (p.phase === 'media' && p.done === 1 && !undoResult) {
            // Another tab: its own blob store object (so no in-tab guard), the same lock name.
            undoResult = undoImportBatch({ ...lib.deps, blobStore: { ...lib.deps.blobStore }, lock }, '00000000-0000-4000-8000-0000000000aa').catch((e: unknown) => e);
            void undoResult.then(() => gate.open(0));
          }
        },
      }),
    );
    expect(await undoResult).toMatchObject({ name: 'ArchiveError', code: 'busy' });
  });

  test('a worker runs one import: a second start is refused, not queued', async () => {
    const events: ImportWorkerEvent[] = [];
    const worker = createImportWorker({ post: (e) => events.push(e), openBlobStore: () => new Promise(() => {}) });
    const port = new MessageChannel();
    const request = { type: 'start', input: {} as ImportWorkerInput, dbPort: port.port1 } as const;
    worker.handle(request);
    worker.handle(request);
    expect(events).toEqual([{ type: 'error', error: { kind: 'internal', message: 'an import worker runs one import' } }]);
    worker.handle({ type: 'cancel' });
    port.port1.close();
    port.port2.close();
  });
});

/** A transport the test drives by hand, to feed the client messages a real worker never sends. */
function manualTransport() {
  let listener: (e: unknown) => void = () => {};
  const transport = {
    posts: [] as ImportWorkerRequest[],
    terminated: 0,
    post: (m: ImportWorkerRequest) => void transport.posts.push(m),
    onMessage: (l: (e: never) => void) => (listener = l as (e: unknown) => void),
    onFailure: () => {},
    terminate: () => void transport.terminated++,
    emit: (e: unknown) => listener(e),
  };
  return transport;
}

describe('importWhatsAppExportInWorker: messages from the worker are untrusted', () => {
  const deps = async () => {
    const lib = await createTestLibrary();
    return { lib, deps: { client: lib.client, blobStore: lib.deps.blobStore } };
  };
  const input = (): ImportWorkerInput => ({ zip: new Blob(['x']), fileName: 'a.zip', profileIds: [], meAuthor: null });

  test('a malformed or unknown error still settles with worker-failed, and nothing throws afterwards', async () => {
    for (const bad of [undefined, null, 'oops', { kind: 'martian', message: 'x' }, {}]) {
      const { deps: d } = await deps();
      const t = manualTransport();
      const run = importWhatsAppExportInWorker(d, input(), { workerUrl: '', createTransport: () => t as never });
      t.emit({ type: 'error', error: bad });
      await expect(run).rejects.toMatchObject({ name: 'ImportError', code: 'worker-failed' });
      expect(t.terminated).toBe(1);
      // Late and repeated messages after the settle are ignored.
      expect(() => {
        t.emit({ type: 'error', error: bad });
        t.emit({ type: 'done', result: {} });
        t.emit({ type: 'progress', progress: { phase: 'media', done: 1, total: 1 } });
      }).not.toThrow();
    }
  });

  test('unknown or empty messages are ignored; the import still ends with the next real one', async () => {
    const { deps: d } = await deps();
    const t = manualTransport();
    const seen: string[] = [];
    const run = importWhatsAppExportInWorker(d, input(), { workerUrl: '', createTransport: () => t as never, onProgress: (p) => seen.push(p.phase) });
    for (const noise of [undefined, null, 42, 'done', {}, { type: 'martian' }]) t.emit(noise);
    t.emit({ type: 'progress', progress: { phase: 'reading', done: 0, total: 1 } });
    t.emit({ type: 'done', result: { status: 'imported' } });
    await expect(run).resolves.toMatchObject({ status: 'imported' });
    expect(seen).toEqual(['reading']);
  });

  test('a progress listener that throws does not break the import', async () => {
    const { deps: d } = await deps();
    const t = manualTransport();
    const run = importWhatsAppExportInWorker(d, input(), {
      workerUrl: '',
      createTransport: () => t as never,
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    t.emit({ type: 'progress', progress: { phase: 'media', done: 0, total: 1 } });
    t.emit({ type: 'done', result: { status: 'imported' } });
    await expect(run).resolves.toMatchObject({ status: 'imported' });
  });
});

describe('createImportWorker: a failure while starting is a typed error, not a hang', () => {
  const start = (dbPort: unknown) => ({ type: 'start', input: {} as ImportWorkerInput, dbPort }) as unknown as ImportWorkerRequest;
  const settleEvents = async (events: ImportWorkerEvent[]) => {
    for (let i = 0; i < 50 && events.length === 0; i++) await new Promise((r) => setTimeout(r));
  };

  test('no database port at all', async () => {
    const events: ImportWorkerEvent[] = [];
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    createImportWorker({ post: (e) => events.push(e), openBlobStore: async () => ({}) as BlobStore }).handle(start(undefined));
    await settleEvents(events);
    process.off('unhandledRejection', onRejection);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'internal' } });
    expect(rejections).toEqual([]);
  });

  test('the database client cannot be created', async () => {
    const events: ImportWorkerEvent[] = [];
    createImportWorker({
      post: (e) => events.push(e),
      openBlobStore: async () => ({}) as BlobStore,
      createDbClient: () => {
        throw new Error('no client');
      },
    }).handle(start(new MessageChannel().port1));
    await settleEvents(events);
    expect(events).toEqual([{ type: 'error', error: { kind: 'internal', message: 'no client' } }]);
  });

  test('the blob store cannot be opened: the typed error comes back and the port is closed', async () => {
    const events: ImportWorkerEvent[] = [];
    let closed = 0;
    createImportWorker({
      post: (e) => events.push(e),
      openBlobStore: async () => {
        throw new Error('no opfs');
      },
      createDbClient: () => ({ call: async () => undefined, close: () => void closed++, connectPort: () => { throw new Error('unused'); } }) as unknown as DbClient,
    }).handle(start(null));
    await settleEvents(events);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'internal', message: 'no opfs' } });
    expect(closed).toBe(1);
  });
});

describe('importWhatsAppExportInWorker: a worker that is killed for real (no cleanup runs)', () => {
  test('killed mid-media: tables unchanged, the finished blob is an orphan until the sweep, import works again', async () => {
    const lib = await setup();
    const before = tableState(lib.opened);
    const transport = loopback(lib, { gate: new Promise<void>(() => {}) }); // the second file never gets written
    await expect(
      lib.run(zipOf(), { transport, onProgress: (p) => p.phase === 'media' && p.done === 1 && transport.kill('killed') }),
    ).rejects.toMatchObject({ name: 'ImportError', code: 'worker-failed', message: 'killed' });
    expect(tableState(lib.opened)).toBe(before);
    // Nothing cleaned up: the first file's bytes are in the store with no row pointing at them.
    expect(await lib.deps.blobStore.list()).toHaveLength(1);
    expect(lib.opened.db.all('SELECT * FROM blobs')).toEqual([]);
    transport.releasePorts();
    expect((await sweepOrphanBlobs(lib.deps)).removed).toBe(1);
    expect(await lib.deps.blobStore.list()).toEqual([]);
    // The guard was released with the failure: the same file imports now.
    expect((await imported(lib.run())).summary).toMatchObject({ added: 5, mediaAdded: 2 });
  });

  test('killed while importMessages is in flight: the batch is committed whole (the transaction is atomic), and a re-import adds nothing', async () => {
    const lib = await setup();
    const transport = loopback(lib, { killWhenSaving: true });
    await expect(lib.run(zipOf(), { transport })).rejects.toMatchObject({ name: 'ImportError', code: 'worker-failed' });
    // The request had left the worker: the database worker still runs it, all or nothing.
    for (let i = 0; i < 100 && lib.opened.db.all('SELECT * FROM import_batches').length === 0; i++) await new Promise((r) => setTimeout(r));
    const count = (table: string) => (lib.opened.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]).n;
    expect([count('messages'), count('import_batches')]).toEqual([5, 1]);
    expect(count('blobs')).toBe(2);
    transport.releasePorts();
    // Nothing is orphaned: the media the batch refers to is all there.
    expect((await sweepOrphanBlobs(lib.deps)).removed).toBe(0);
    expect(await lib.deps.blobStore.list()).toHaveLength(2);
    const again = await imported(lib.run());
    expect(again.summary).toMatchObject({ added: 0, alreadyThere: 5, mediaAdded: 0 });
  });
});

describe('importWhatsAppExportInWorker: cancel and grace timing (fake timers)', () => {
  afterEach(() => vi.useRealTimers());

  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  /** Advance the fake clock, then let the real message ports deliver. */
  const pump = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((r) => setImmediate(r));
  };
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 1000 && !condition(); i++) await pump(1);
    expect(condition()).toBe(true);
  };
  const manualGate = () => {
    let open: () => void = () => {};
    return { promise: new Promise<void>((resolve) => (open = resolve)), open };
  };
  const track = (promise: Promise<unknown>) => {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    return state;
  };

  test('a cancel once saving has started waits for the outcome: it commits and resolves imported, even after 15 s', async () => {
    fake();
    const lib = await setup();
    const dbGate = manualGate();
    const transport = loopback(lib, { dbGate: dbGate.promise });
    const controller = new AbortController();
    let sawSaving = false;
    const run = lib.run(zipOf(), {
      transport,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'saving' && !sawSaving) {
          sawSaving = true;
          controller.abort();
        }
      },
    });
    const state = track(run);
    await until(() => sawSaving);
    await until(() => transport.requests.some((r) => r.type === 'cancel'));
    await pump(20_000); // well past the grace period
    expect(state.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no grace timer is armed
    expect(transport.terminated).toBe(0);
    dbGate.open();
    await until(() => state.settled);
    const result = await run;
    expect(result.status).toBe('imported');
    if (result.status !== 'imported') return;
    expect(result.summary.added).toBe(5);
    expect(await lib.client.call('listMessages', { conversationId: result.conversationId, limit: 100 })).toHaveLength(5);
  });

  test('a cancel before saving arms the grace timer; "saving" arriving afterwards disarms it', async () => {
    fake();
    const lib = await setup();
    const gate = manualGate();
    const controller = new AbortController();
    const transport = loopback(lib, { ignoreCancel: true, gate: gate.promise });
    let aborted = false;
    const run = lib.run(zipOf(), {
      transport,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'media' && p.done === 1 && !aborted) {
          aborted = true;
          controller.abort();
        }
      },
    });
    const state = track(run);
    await until(() => aborted);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    gate.open(); // the worker never saw the cancel and goes on to save
    await until(() => state.settled);
    await expect(run).resolves.toMatchObject({ status: 'imported' });
  });

  test('the grace period is 15 s: pending at 14_999 ms, worker-failed at 15_000 ms, worker terminated', async () => {
    fake();
    const lib = await setup();
    const gate = manualGate();
    const controller = new AbortController();
    const transport = loopback(lib, { ignoreCancel: true, gate: gate.promise });
    let aborted = false;
    let abortedAt = 0;
    const run = lib.run(zipOf(), {
      transport,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'media' && p.done === 1 && !aborted) {
          aborted = true;
          abortedAt = Date.now();
          controller.abort();
        }
      },
    });
    const outcome = run.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    const state = track(outcome);
    await until(() => aborted);
    await pump(abortedAt + 14_999 - Date.now());
    expect(state.settled).toBe(false);
    expect(transport.terminated).toBe(0);
    await pump(1); // exactly 15_000 ms after the cancel
    await until(() => state.settled);
    expect(await outcome).toMatchObject({ name: 'ImportError', code: 'worker-failed' });
    expect(transport.terminated).toBe(1);
    gate.open();
  });

  test('a cancel the worker honours clears the timer and rejects with the caller\'s own reason', async () => {
    fake();
    const lib = await setup();
    const gate = manualGate();
    const controller = new AbortController();
    const reason = new Error('the person pressed cancel');
    const transport = loopback(lib, { gate: gate.promise });
    let aborted = false;
    const run = lib.run(zipOf(), {
      transport,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'media' && p.done === 1 && !aborted) {
          aborted = true;
          controller.abort(reason);
        }
      },
    });
    const outcome = run.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    const state = track(outcome);
    await until(() => aborted);
    await until(() => transport.requests.some((r) => r.type === 'cancel'));
    await pump(10); // the cancel has reached the worker
    gate.open();
    await until(() => state.settled);
    expect(await outcome).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    await pump(20_000); // nothing fires afterwards
    expect(transport.terminated).toBe(1);
    expect(await lib.deps.blobStore.list()).toEqual([]);
  });
});
