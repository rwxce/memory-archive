import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ArchiveError } from '@/lib/usecases/archive-backup';
import { BUSY_RETRIES, BUSY_RETRY_MS, retryWhileBusy } from './retry-busy';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('a busy refusal is tried again until the archive is free', async () => {
  const work = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new ArchiveError('busy', 'x')).mockRejectedValueOnce(new ArchiveError('busy', 'x')).mockResolvedValue('ok');
  const result = retryWhileBusy(work);
  await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
  await expect(result).resolves.toBe('ok');
  expect(work).toHaveBeenCalledTimes(3);
});

test('it gives up with busy after the bounded number of tries', async () => {
  const work = vi.fn<() => Promise<string>>().mockRejectedValue(new ArchiveError('busy', 'x'));
  const result = retryWhileBusy(work).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * (BUSY_RETRIES + 1));
  expect(await result).toMatchObject({ code: 'busy' });
  expect(work).toHaveBeenCalledTimes(BUSY_RETRIES + 1);
});

test('other failures are not retried, and an abort stops the waiting', async () => {
  const other = vi.fn<() => Promise<string>>().mockRejectedValue(new ArchiveError('integrity', 'x'));
  await expect(retryWhileBusy(other)).rejects.toMatchObject({ code: 'integrity' });
  expect(other).toHaveBeenCalledTimes(1);

  const controller = new AbortController();
  const busy = vi.fn<() => Promise<string>>().mockRejectedValue(new ArchiveError('busy', 'x'));
  const result = retryWhileBusy(busy, controller.signal).catch((e: unknown) => e);
  controller.abort();
  await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
  expect(await result).not.toMatchObject({ code: 'busy' });
  expect(busy).toHaveBeenCalledTimes(1);
});
