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

export function createQueue(limit: number) {
  let running = 0;
  const waiting: Entry[] = [];
  const pump = () => {
    while (running < limit && waiting.length > 0) waiting.shift()!.run();
  };
  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length;
    },
    enqueue<T>(task: () => Promise<T>): Queued<T> {
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
      waiting.push(entry);
      pump();
      return {
        promise,
        cancel() {
          const at = waiting.indexOf(entry);
          if (at === -1) return;
          waiting.splice(at, 1);
          entry.abort();
        },
      };
    },
  };
}

/** One queue for the whole view: at most this many files are read from storage at a time. */
export const MEDIA_READS_AT_ONCE = 3;
export const mediaQueue = createQueue(MEDIA_READS_AT_ONCE);
