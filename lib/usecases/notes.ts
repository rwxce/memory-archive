import type { Note, NoteItem, NoteTarget } from '../domain/library';
import { WINDOW_SIZE } from './conversation-view';
import { nowOf, type LibraryDeps } from './profiles';

/**
 * Notes: one editable text on a person, a conversation or a message (a date comes with it:
 * `createdAt` / `updatedAt`). A message note is kept by `(conversation, fingerprint)`, so it
 * survives backup, restore and merge; the screen only passes the local message id. Notes are
 * personal text and are part of every backup. Failures are `DbError`s: `not-found` (unknown
 * profile / conversation, or a message that is not in that conversation), `invalid` (bad ids,
 * offset, a note over `NOTE_MAX`, a scope naming both a profile and a conversation).
 */

/** Which notes to read: of one person (and their conversations), of one conversation, or all. */
export type NoteScope = { profileId: string } | { conversationId: string } | undefined;

/** The note on a target, or `null` when it has none. */
export function getNote(deps: LibraryDeps, target: NoteTarget): Promise<Note | null> {
  return deps.client.call('getNote', { target });
}

/**
 * Saves the note on a target and returns it as stored (trimmed). An empty text deletes the note
 * and returns `null`, so there is no separate delete. Saving the same text changes nothing.
 */
export function setNote(deps: LibraryDeps, target: NoteTarget, body: string): Promise<Note | null> {
  return deps.client.call('setNote', { target, body, now: nowOf(deps) });
}

/** How many notes exist in the scope (those on a message that is not in the archive are not counted). */
export function countNotes(deps: LibraryDeps, scope?: NoteScope): Promise<number> {
  return deps.client.call('countNotes', { scope });
}

/** Notes at positions `offset`..`offset + limit`, the most recently edited first. */
export function listNotes(deps: LibraryDeps, scope: NoteScope, offset: number, limit: number = WINDOW_SIZE): Promise<NoteItem[]> {
  return deps.client.call('listNotes', { scope, offset, limit });
}
