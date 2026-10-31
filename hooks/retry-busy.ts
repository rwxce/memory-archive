import { ArchiveError } from '@/lib/usecases/archive-backup';

/**
 * An archive operation is refused (`busy`) while another one runs in this tab, and the library's own
 * clean-up at open is one. It ends within moments, so a refused operation is tried again a few times
 * (about 3 s in all) before the person is told. `busy` is thrown before the operation does anything, so
 * trying again is safe. Any other failure, or an aborted `signal`, ends it at once.
 */
export const BUSY_RETRY_MS = 250;
export const BUSY_RETRIES = 12;

export async function retryWhileBusy<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ArchiveError) || error.code !== 'busy' || attempt >= BUSY_RETRIES) throw error;
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      signal?.throwIfAborted();
    }
  }
}
