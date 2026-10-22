/**
 * Where a conversation was left, kept for this tab only (sessionStorage) so the back button
 * returns to the same place. It is a row number and an offset: no message text, no names.
 * Storage that is unavailable or holds something else is simply "no position".
 */
export interface SavedPosition {
  index: number;
  within: number;
}

const key = (conversationId: string) => `memory-archive:position:${conversationId}`;

export function savePosition(conversationId: string, position: SavedPosition | undefined, storage: Pick<Storage, 'setItem'> = sessionStorage): void {
  if (!position) return;
  try {
    storage.setItem(key(conversationId), JSON.stringify(position));
  } catch {
    // Private mode or quota: nothing to restore later, nothing lost.
  }
}

export function loadPosition(conversationId: string, count: number, storage: Pick<Storage, 'getItem'> = sessionStorage): SavedPosition | undefined {
  try {
    const raw = storage.getItem(key(conversationId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<SavedPosition>;
    if (!Number.isInteger(value.index) || !(typeof value.within === 'number' && Number.isFinite(value.within))) return undefined;
    if (value.index! < 0 || value.index! >= count || value.within! < 0 || value.within! > 100_000) return undefined;
    return { index: value.index!, within: value.within! };
  } catch {
    return undefined;
  }
}
