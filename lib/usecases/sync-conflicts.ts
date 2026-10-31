import type { ConflictChoice, ExpectedConflict, SyncConflict } from '../domain/sync';
import { DbError } from '../db/errors';
import { withArchiveGuard } from './archive-guard';
import { listConversations } from './conversations';
import { deleteBlobs, undoImportBatch } from './import';
import { listProfiles, nowOf, type LibraryDeps, type ProfileDeps } from './profiles';

/*
 * The crossed edits and offered import undos a changes-pack merge left open
 * (`docs/formats/changes-pack.md`, "Conflicts"). Data layer only: the screen that shows both
 * versions is a separate step. Failures are `DbError`s (`not-found` when it was settled meanwhile,
 * `invalid` for a choice that does not fit the record).
 */

/** Every open conflict with both versions, plus the undone imports other devices offer, oldest first. */
export function listSyncConflicts(deps: LibraryDeps): Promise<SyncConflict[]> {
  return deps.client.call('listSyncConflicts', undefined);
}

/** What happened. `undone`: an import undo was accepted and the import was still here (false: it was already gone). */
export interface ResolveSyncConflictResult {
  recordGone: boolean;
  undone: boolean;
  /** The local note or record was already missing when this was settled, so there was nothing here to keep or replace. */
  localMissing: boolean;
}

/**
 * Settles a conflict as an ordinary local edit (it travels to the other device as a normal change):
 * `mine` keeps the active record, `theirs` takes the other device's, `both` (notes only) keeps both
 * texts. An offered import undo is accepted with `theirs`, which runs the normal undo here (removing
 * those messages, and the media nothing else uses) and then closes the offer, or dismissed with
 * `mine`; if the import is no longer here there is nothing to remove and the offer just closes (`undone: false`).
 * `recordGone`: `theirs` for a person or conversation that was removed here meanwhile and could not be
 * brought back; the conflict is closed and nothing was applied.
 *
 * `expected` is the version the person looked at (`key` and `detectedAt`). A conflict id can be reused and a newer
 * incoming version replaces its row in place, so when the open row is not that one nothing changes and this throws
 * `not-found`, like a conflict settled meanwhile.
 */
export async function resolveSyncConflict(
  deps: ProfileDeps,
  id: number,
  choice: ConflictChoice,
  expected: ExpectedConflict,
): Promise<ResolveSyncConflictResult> {
  const conflict = (await listSyncConflicts(deps)).find((c) => c.id === id);
  if (conflict && (conflict.key !== expected.key || conflict.detectedAt !== expected.detectedAt)) throw new DbError('not-found', 'conflict not found');
  if (conflict?.kind === 'batch' && choice === 'theirs') {
    const undone = conflict.matched ? (await undoImportBatch(deps, conflict.key)).found : false;
    // The undo already closed the offer; closing it again is only for an offer whose import is gone.
    await deps.client.call('resolveSyncConflict', { id, choice: 'mine', now: nowOf(deps), expected }).catch((error: unknown) => {
      if (!(error instanceof DbError && error.code === 'not-found')) throw error;
    });
    return { recordGone: false, undone, localMissing: false };
  }
  const result = await withArchiveGuard(deps.blobStore, () => deps.client.call('resolveSyncConflict', { id, choice, now: nowOf(deps), expected }), deps.lock);
  await deleteBlobs(deps, result.unreferencedBlobs);
  return { recordGone: result.recordGone, undone: false, localMissing: result.localMissing };
}

/**
 * Names for the notes among `conflicts`: the conversation (or person) each note is on, by conflict id. A note whose
 * target cannot be found simply has no entry.
 */
export async function describeNoteConflicts(deps: LibraryDeps, conflicts: SyncConflict[]): Promise<Map<number, string>> {
  const notes = conflicts.filter((c) => c.kind === 'note');
  const names = new Map<number, string>();
  if (notes.length === 0) return names;
  const [conversations, people] = await Promise.all([listConversations(deps), listProfiles(deps, 'all')]);
  const titles = new Map(conversations.map((c) => [c.id, c.title]));
  const persons = new Map(people.map((p) => [p.id, p.displayName]));
  for (const note of notes) {
    const name = note.scope === '' ? persons.get(note.key.slice('profile:'.length)) : titles.get(note.scope);
    if (name) names.set(note.id, name);
  }
  return names;
}
