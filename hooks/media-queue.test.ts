import { describe, expect, test } from 'vitest';
import { Cancelled, createQueue } from './media-queue';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('createQueue', () => {
  test('never runs more than the limit at once, and runs the rest in order as slots free up', async () => {
    const queue = createQueue(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let peak = 0;
    const jobs = gates.map((gate, i) =>
      queue.enqueue(async () => {
        started.push(i);
        peak = Math.max(peak, queue.running);
        await gate.promise;
        return i;
      }),
    );
    expect(started).toEqual([0, 1]);
    expect(queue.waiting).toBe(2);
    gates[0].resolve();
    await jobs[0].promise;
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates.slice(1).forEach((g) => g.resolve());
    expect(await Promise.all(jobs.map((j) => j.promise))).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(queue.running).toBe(0);
  });

  test('a task cancelled while waiting never runs and rejects as Cancelled; a running one is unaffected', async () => {
    const queue = createQueue(1);
    const gate = deferred();
    let ran = 0;
    const first = queue.enqueue(async () => {
      ran++;
      await gate.promise;
      return 'a';
    });
    const second = queue.enqueue(async () => {
      ran++;
      return 'b';
    });
    second.cancel();
    first.cancel();
    await expect(second.promise).rejects.toBeInstanceOf(Cancelled);
    gate.resolve();
    expect(await first.promise).toBe('a');
    expect(ran).toBe(1);
    expect(queue.waiting).toBe(0);
  });

  test('a failing task frees its slot', async () => {
    const queue = createQueue(1);
    const bad = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const good = queue.enqueue(async () => 'ok');
    await expect(bad.promise).rejects.toThrow('boom');
    expect(await good.promise).toBe('ok');
  });
});
