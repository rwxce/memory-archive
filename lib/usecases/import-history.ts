import type { ImportBatchCursor, ImportBatchRow } from '../db/queries';
import { undoImportBatch, type UndoImportResult } from './import';
import type { LibraryDeps, ProfileDeps } from './profiles';

/**
 * Import history: what each import added, and taking one back.
 *
 * A batch is listed until it is undone (undo deletes its row), so there is no "undone" state. A
 * re-import that added nothing and created nothing is not listed. Per-batch media added/skipped
 * counts are not recorded (no schema change for them); `mediaPresent` counts the batch's
 * messages that still carry a media file.
 */
export interface ImportHistoryEntry extends Omit<ImportBatchRow, 'profileIds'> {
  /** Names of the profiles the conversation is filed under now (empty: not assigned). */
  profileNames: string[];
  profileIds: string[];
}

export interface ImportHistoryFilter {
  conversationId?: string;
  profileId?: string;
  before?: ImportBatchCursor;
  /** Default 50, at most 200. */
  limit?: number;
}

/** One page of the history, newest first. A full page may have a next one: pass the last entry as `before`. */
export async function listImportHistory(deps: LibraryDeps, filter: ImportHistoryFilter = {}): Promise<ImportHistoryEntry[]> {
  const batches = await deps.client.call('listImportBatches', filter);
  if (batches.length === 0) return [];
  const names = new Map((await deps.client.call('listProfiles', { state: 'all' })).map((p) => [p.id, p.displayName]));
  return batches.map((b) => ({ ...b, profileNames: b.profileIds.flatMap((id) => names.get(id) ?? []) }));
}

/** The cursor for the page after `entry`. */
export const historyCursorOf = (entry: Pick<ImportBatchRow, 'createdAt' | 'id'>): ImportBatchCursor => ({
  createdAt: entry.createdAt,
  id: entry.id,
});

/**
 * Undoes one import from the history: exactly the wizard's undo (same archive guard and
 * cross-tab lock, so `busy` while an import, backup or restore runs; same result).
 */
export function undoImport(deps: ProfileDeps, batchId: string): Promise<UndoImportResult> {
  return undoImportBatch(deps, batchId);
}
