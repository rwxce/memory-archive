import type { MediaMessageType, PersonMediaItem } from '../domain/library';
import { WINDOW_SIZE } from './conversation-view';
import type { LibraryDeps } from './profiles';

/**
 * A person's media across every conversation filed under them (their audio, later photos and
 * videos). Chronological, paged by offset. The bytes come from `readBlob` / `blobSize`
 * (conversation-view.ts / conversation-media.ts), one item at a time. Failures are `DbError`s:
 * `not-found` (no such profile), `invalid` (empty or non-media `kinds`, bad offset).
 */

export function countPersonMedia(deps: LibraryDeps, profileId: string, kinds: MediaMessageType[]): Promise<number> {
  return deps.client.call('countPersonMedia', { profileId, kinds });
}

/** Items at positions `offset`..`offset + limit` (oldest first; empty past the end). */
export function listPersonMedia(
  deps: LibraryDeps,
  profileId: string,
  kinds: MediaMessageType[],
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<PersonMediaItem[]> {
  return deps.client.call('listPersonMedia', { profileId, kinds, offset, limit });
}
