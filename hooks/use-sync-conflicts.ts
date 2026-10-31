'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictChoice, ExpectedConflict, SyncConflict } from '@/lib/domain/sync';
import { listConversations } from '@/lib/usecases/conversations';
import { historyCursorOf, listImportHistory, type ImportHistoryEntry } from '@/lib/usecases/import-history';
import type { LibraryDeps } from '@/lib/usecases/profiles';
import { describeNoteConflicts, listSyncConflicts, resolveSyncConflict } from '@/lib/usecases/sync-conflicts';
import { useLibraryInternals } from './use-library';

/** The import an offer is about, as this device knows it. */
export interface OfferedBatch {
  title: string | null;
  messages: number;
  /** The import created the conversation, so undoing it removes the conversation too. */
  createdConversation: boolean;
  /** Every message the conversation holds now; undoing the import removes the conversation itself only when this equals `messages`. Null: not known. */
  conversationMessages: number | null;
}

/** `batch`: the import an offer is about. `noteOn`: the conversation or person a note is on, when it can be found. */
export type ConflictItem = SyncConflict & { batch?: OfferedBatch; noteOn?: string };

/** A conflict is one version of one record: the id can be reused, so the incoming version it was detected with is part of its identity. */
export const conflictKeyOf = (c: Pick<SyncConflict, 'id' | 'detectedAt'>): string => `${c.id}:${c.detectedAt}`;

export type SyncConflictsState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: ConflictItem[] };

/** What happened to one conflict. Never text from the other device. */
export type ConflictOutcomeKind =
  | 'mine'
  | 'theirs'
  | 'both'
  | 'undone'
  | 'dismissed'
  /** `theirs` for a record that was removed here meanwhile: nothing was applied. */
  | 'record-gone'
  /** It was settled meanwhile (another tab). */
  | 'settled'
  /** It was already gone from this device: nothing to remove, keep or replace. */
  | 'already-gone'
  /** `both` for a note that was deleted here meanwhile: only the other device's text was added. */
  | 'both-restored'
  | 'busy'
  | 'too-long'
  | 'failed';

export interface ConflictOutcome {
  kind: ConflictOutcomeKind;
  /** Changes on every outcome, so an identical message is announced again. */
  seq: number;
}

const HISTORY_PAGE = 200;
const HISTORY_PAGES = 10;

/** Finds the imports the offers are about, a page at a time, stopping when all are found. */
async function describeBatches(deps: LibraryDeps, conflicts: SyncConflict[]): Promise<Map<string, ImportHistoryEntry>> {
  const wanted = new Set(conflicts.filter((c) => c.kind === 'batch' && c.matched).map((c) => c.key));
  const found = new Map<string, ImportHistoryEntry>();
  let before: ReturnType<typeof historyCursorOf> | undefined;
  for (let page = 0; wanted.size > found.size && page < HISTORY_PAGES; page++) {
    const entries = await listImportHistory(deps, { limit: HISTORY_PAGE, ...(before ? { before } : {}) });
    for (const entry of entries) if (wanted.has(entry.id)) found.set(entry.id, entry);
    if (entries.length < HISTORY_PAGE) break;
    before = historyCursorOf(entries[entries.length - 1]);
  }
  return found;
}

/** Message counts per conversation, only when an offer needs them. A courtesy: unknown counts make the question more careful. */
async function conversationTotals(deps: LibraryDeps, conflicts: SyncConflict[]): Promise<Map<string, number>> {
  if (!conflicts.some((c) => c.kind === 'batch' && c.matched)) return new Map();
  try {
    return new Map((await listConversations(deps)).map((c) => [c.id, c.messageCount]));
  } catch {
    return new Map();
  }
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/**
 * The open sync conflicts (crossed edits and offered import undos) and settling them one at a time. A conflict being
 * settled ignores a second request (no double click). After each outcome the list is read again, and `onChanged` lets
 * the device and import counts follow.
 */
export function useSyncConflicts(onChanged?: () => void): {
  state: SyncConflictsState;
  outcome: ConflictOutcome | undefined;
  working: ReadonlySet<number>;
  resolve: (id: number, choice: ConflictChoice, expected: ExpectedConflict) => Promise<void>;
  reload: () => void;
} {
  const { state: library, refresh, register } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [state, setState] = useState<SyncConflictsState>({ status: 'loading' });
  const [outcome, setOutcome] = useState<ConflictOutcome>();
  const [working, setWorking] = useState<ReadonlySet<number>>(new Set());
  const inFlight = useRef(new Set<number>());
  const latest = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    try {
      const conflicts = await listSyncConflicts(deps);
      // The names are a courtesy: an offer is still shown, and can still be answered, without them.
      const batches = await describeBatches(deps, conflicts).catch(() => new Map<string, ImportHistoryEntry>());
      const noteNames = await describeNoteConflicts(deps, conflicts).catch(() => new Map<number, string>());
      const totals = await conversationTotals(deps, conflicts);
      if (mine !== latest.current) return;
      const items = conflicts.map((c): ConflictItem => {
        const entry = c.kind === 'batch' ? batches.get(c.key) : undefined;
        const batch: OfferedBatch | undefined = entry
          ? {
              title: entry.conversationTitle,
              messages: entry.messagesPresent,
              createdConversation: entry.createdConversation,
              conversationMessages: (entry.conversationId === null ? undefined : totals.get(entry.conversationId)) ?? null,
            }
          : undefined;
        const noteOn = noteNames.get(c.id);
        return { ...c, ...(batch ? { batch } : {}), ...(noteOn ? { noteOn } : {}) };
      });
      setState({ status: 'ready', items });
    } catch {
      if (mine === latest.current) setState({ status: 'error' });
    }
  }, [deps]);

  useEffect(() => {
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [load, register]);

  const say = useCallback((kind: ConflictOutcomeKind) => setOutcome({ kind, seq: ++seq.current }), []);

  const resolve = useCallback(
    async (id: number, choice: ConflictChoice, expected: ExpectedConflict) => {
      if (!deps || inFlight.current.has(id)) return;
      const conflict = state.status === 'ready' ? state.items.find((c) => c.id === id) : undefined;
      inFlight.current.add(id);
      setWorking(new Set(inFlight.current));
      let kind: ConflictOutcomeKind;
      try {
        const { recordGone, undone, localMissing } = await resolveSyncConflict(deps, id, choice, expected);
        if (recordGone) kind = 'record-gone';
        else if (conflict?.kind === 'batch') kind = choice === 'theirs' ? (undone ? 'undone' : 'already-gone') : 'dismissed';
        else if (conflict?.kind === 'note' && localMissing && conflict.incomingDeleted) kind = 'already-gone';
        else if (conflict?.kind === 'note' && localMissing && choice === 'both') kind = 'both-restored';
        else kind = choice;
      } catch (error) {
        const code = codeOf(error);
        if (code === 'not-found') kind = 'settled';
        else if (code === 'busy') kind = 'busy';
        else if (code === 'invalid' && choice === 'both') kind = 'too-long';
        else kind = 'failed';
      } finally {
        inFlight.current.delete(id);
        setWorking(new Set(inFlight.current));
      }
      say(kind);
      // A failure may still have changed something (an undo that finished before the offer closed): read again either way.
      if (kind !== 'busy') {
        await load();
        try {
          await refresh();
        } catch {
          // The conflict is settled; other screens read again when opened.
        }
        onChanged?.();
      }
    },
    [deps, state, load, refresh, say, onChanged],
  );

  const reload = useCallback(() => void load(), [load]);
  return { state, outcome, working, resolve, reload };
}
