import type { SearchResult, SearchStatus } from '../domain/library';
import { toMatchExpression } from '../domain/search-query';
import { WINDOW_SIZE } from './conversation-view';
import type { LibraryDeps } from './profiles';

/**
 * Full-text search over message text and media file names. It runs on a DERIVED index: a cache of
 * the message text in its own file next to the library, never part of a backup, rebuilt on
 * demand (after a restore, an undo or any change, the next search brings it up to date first).
 * Erasing the library must erase that file too (`docs/privacy.md`).
 *
 * Failures are `DbError`s: `invalid` (bad scope, offset or limit), `not-found` (unknown person
 * or conversation), `unavailable` (the index file cannot be opened).
 */

/** Whose messages to search: one person's conversations, one conversation, or (no scope) all. */
export type SearchScope = { profileId: string } | { conversationId: string } | undefined;

export interface BuildSearchIndexOptions {
  /** Called after every chunk. `done` counts messages looked at in the current pass, `total` is the archive size. */
  onProgress?: (progress: { done: number; total: number }) => void;
  /** Stops between chunks (the index keeps what it has; the next build continues). Rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Passes tried at most when the archive keeps changing under the build (each pass is cheap once the index is current). */
const MAX_PASSES = 5;

export function getSearchStatus(deps: LibraryDeps): Promise<SearchStatus> {
  return deps.client.call('getSearchStatus');
}

interface SharedBuild {
  participants: BuildSearchIndexOptions[];
  done: Promise<void>;
}

const running = new WeakMap<object, SharedBuild>();

/**
 * Brings the index up to date: builds it the first time, afterwards only reconciles (adds what is
 * new, removes what is gone). Chunked, so the database worker answers other requests in between.
 * One build runs at a time per library and a second call joins it (its `onProgress` is called too).
 * An abort rejects only the caller whose signal it is; the shared build stops between chunks only
 * when every caller that joined has aborted.
 */
export function buildSearchIndex(deps: LibraryDeps, options: BuildSearchIndexOptions = {}): Promise<void> {
  const key = deps.client;
  let shared = running.get(key);
  if (shared) shared.participants.push(options);
  else {
    const created: SharedBuild = { participants: [options], done: Promise.resolve() };
    created.done = run(deps, created).finally(() => running.delete(key));
    running.set(key, created);
    shared = created;
  }
  const { signal } = options;
  if (!signal) return shared.done;
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    shared.done.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function run(deps: LibraryDeps, shared: SharedBuild): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { total } = await getSearchStatus(deps);
    let done = 0;
    for (;;) {
      if (shared.participants.every((p) => p.signal?.aborted)) throw shared.participants[0].signal?.reason;
      const step = await deps.client.call('stepSearchIndex');
      done = Math.min(done + step.processed, total);
      for (const p of shared.participants) p.onProgress?.({ done, total });
      if (step.finished) {
        if (step.verified) return;
        break;
      }
    }
  }
}

/**
 * Messages matching `query` in the scope, newest first, `limit` from position `offset`. Every word
 * must match, the last one as a prefix; case and accents are ignored; punctuation and operators
 * typed by the person are just ignored. An empty query finds nothing. If the index is missing or
 * out of date it is brought up to date first (call `buildSearchIndex` earlier to show progress).
 * Each result has a `snippet` whose `ranges` mark the match: plain text, escape it on render.
 */
export async function searchMessages(
  deps: LibraryDeps,
  scope: SearchScope,
  query: string,
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<SearchResult[]> {
  if (toMatchExpression(query) === null) return [];
  if ((await getSearchStatus(deps)).state !== 'ready') await buildSearchIndex(deps);
  return deps.client.call('searchMessages', { scope, query, offset, limit });
}
