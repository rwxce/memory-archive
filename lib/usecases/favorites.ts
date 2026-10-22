import type { PersonTimelineMessage } from '../domain/library';
import { WINDOW_SIZE } from './conversation-view';
import { nowOf, type LibraryDeps } from './profiles';

/**
 * Favorite messages (a media message is a message, so media favorites are the ones with media).
 * A favorite is kept by `(conversation, fingerprint)`, so it survives backup, restore and merge;
 * the screen only ever passes the local message id. Failures are `DbError`s: `not-found` (no such
 * message in that conversation / profile / conversation), `invalid` (bad ids, offset, or a scope
 * naming both a profile and a conversation).
 */

/** Which favorites to read: of one person, of one conversation, or (no scope) the whole archive. */
export type FavoriteScope = { profileId: string } | { conversationId: string } | undefined;

/** Marks (`true`) or unmarks (`false`) a message. Idempotent. */
export function setFavorite(deps: LibraryDeps, conversationId: string, messageId: number, favorite: boolean): Promise<boolean> {
  return deps.client.call('setFavorite', { conversationId, messageId, favorite, now: nowOf(deps) }).then((r) => r.isFavorite);
}

/** How many favorites exist in the scope (those whose message is not in the archive are not counted). */
export function countFavorites(deps: LibraryDeps, scope?: FavoriteScope): Promise<number> {
  return deps.client.call('countFavorites', { scope });
}

/** Favorites at positions `offset`..`offset + limit`, oldest message first across conversations. */
export function listFavorites(
  deps: LibraryDeps,
  scope: FavoriteScope,
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<PersonTimelineMessage[]> {
  return deps.client.call('listFavorites', { scope, offset, limit });
}
