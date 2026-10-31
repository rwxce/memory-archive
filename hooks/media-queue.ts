/**
 * Runs at most `limit` tasks at once; the rest wait their turn. A task cancelled before it
 * starts never runs (a row scrolled past before its photo was read costs nothing).
 */
export interface Queued<T> {
  promise: Promise<T>;
  /** Stops a task that has not started; one already running finishes and its result is ignored. */
  cancel(): void;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

interface Entry {
  run(): void;
  abort(): void;
}

export interface EnqueueOptions {
  /**
   * A read the person is waiting for (the picture they opened) rather than background work (tiles). It goes ahead of
   * everything waiting and may use one slot beyond `limit`, so it never waits behind a row of tile reads.
   */
  priority?: 'high';
}

/** Extra reads allowed at once, for `priority: 'high'` tasks only. */
const URGENT_SLOTS = 1;

export function createQueue(limit: number) {
  let running = 0;
  const waiting: Entry[] = [];
  const urgent: Entry[] = [];
  const pump = () => {
    while (urgent.length > 0 && running < limit + URGENT_SLOTS) urgent.shift()!.run();
    while (running < limit && waiting.length > 0) waiting.shift()!.run();
  };
  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length + urgent.length;
    },
    enqueue<T>(task: () => Promise<T>, options: EnqueueOptions = {}): Queued<T> {
      const lane = options.priority === 'high' ? urgent : waiting;
      let entry!: Entry;
      const promise = new Promise<T>((resolve, reject) => {
        entry = {
          run() {
            running++;
            task()
              .then(resolve, reject)
              .finally(() => {
                running--;
                pump();
              });
          },
          abort: () => reject(new Cancelled()),
        };
      });
      lane.push(entry);
      pump();
      return {
        promise,
        cancel() {
          const at = lane.indexOf(entry);
          if (at === -1) return;
          lane.splice(at, 1);
          entry.abort();
        },
      };
    },
  };
}

/** One queue for the whole view: at most this many files are read from storage at a time. */
export const MEDIA_READS_AT_ONCE = 3;
export const mediaQueue = createQueue(MEDIA_READS_AT_ONCE);
