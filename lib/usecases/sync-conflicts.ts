import type { ConflictChoice, SyncConflict } from '../domain/sync';
import { DbError } from '../db/errors';
import { withArchiveGuard } from './archive-guard';
import { deleteBlobs, undoImportBatch } from './import';
import { nowOf, type LibraryDeps, type ProfileDeps } from './profiles';

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

/**
 * Settles a conflict as an ordinary local edit (it travels to the other device as a normal change):
 * `mine` keeps the active record, `theirs` takes the other device's, `both` (notes only) keeps both
 * texts. An offered import undo is accepted with `theirs`, which runs the normal undo here (removing
 * those messages, and the media nothing else uses) and then closes the offer, or dismissed with
 * `mine`; if the import is no longer here there is nothing to remove and the offer just closes.
 */
export async function resolveSyncConflict(deps: ProfileDeps, id: number, choice: ConflictChoice): Promise<void> {
  const conflict = (await listSyncConflicts(deps)).find((c) => c.id === id);
  if (conflict?.kind === 'batch' && choice === 'theirs') {
    if (conflict.matched) await undoImportBatch(deps, conflict.key);
    // The undo already closed the offer; closing it again is only for an offer whose import is gone.
    await deps.client.call('resolveSyncConflict', { id, choice: 'mine', now: nowOf(deps) }).catch((error: unknown) => {
      if (!(error instanceof DbError && error.code === 'not-found')) throw error;
    });
    return;
  }
  const result = await withArchiveGuard(deps.blobStore, () => deps.client.call('resolveSyncConflict', { id, choice, now: nowOf(deps) }), deps.lock);
  await deleteBlobs(deps, result.unreferencedBlobs);
}
