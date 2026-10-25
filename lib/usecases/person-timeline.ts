import type { ConversationBounds, ConversationDay, PersonTimelineMessage } from '../domain/library';
import { WINDOW_SIZE } from './conversation-view';
import type { LibraryDeps } from './profiles';

/**
 * A person's combined timeline: the messages of every conversation linked to them, merged
 * chronologically, read by position like the conversation view (count, windows by offset, jump
 * by date, days for a calendar). Each message says which conversation it came from. Failures are
 * `DbError`s: `not-found` (no such profile), `invalid` (bad offset or date).
 */

export function getPersonTimelineBounds(deps: LibraryDeps, profileId: string): Promise<ConversationBounds> {
  return deps.client.call('getPersonTimelineBounds', { profileId });
}

/** Messages at positions `offset`..`offset + limit` (oldest first; empty past the end). */
export function getPersonTimelineWindow(
  deps: LibraryDeps,
  profileId: string,
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<PersonTimelineMessage[]> {
  return deps.client.call('getPersonTimelineWindow', { profileId, offset, limit });
}

/** Offset of the first message on or after a local date `YYYY-MM-DD`; `null` when all are earlier. */
export function findPersonTimelineOffsetByDate(deps: LibraryDeps, profileId: string, date: string): Promise<number | null> {
  return deps.client.call('findPersonTimelineOffsetByDate', { profileId, date });
}

/** Offset of one message in the person's timeline (0-based); `null` when it is not in it. */
export function findPersonTimelineOffsetById(deps: LibraryDeps, profileId: string, messageId: number): Promise<number | null> {
  return deps.client.call('findPersonTimelineOffsetById', { profileId, messageId });
}

/** Days that have messages, with counts and first offsets. */
export function listPersonTimelineDays(deps: LibraryDeps, profileId: string): Promise<ConversationDay[]> {
  return deps.client.call('listPersonTimelineDays', { profileId });
}
