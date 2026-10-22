'use client';

import { useCallback, useEffect, useState } from 'react';
import { isUuid } from '@/lib/domain/library';
import { findMessageOffsetByDate, openConversationView, type ConversationView } from '@/lib/usecases/conversation-view';
import { listProfiles } from '@/lib/usecases/profiles';
import { loadPosition } from './conversation-position';
import type { ListStart } from './use-virtual-list';
import { useLibraryInternals } from './use-library';

export interface OpenConversation {
  view: ConversationView;
  /** The people it is filed under, by name, in the order of their links; archived people included. */
  people: Array<{ id: string; name: string }>;
  /** Where to open: the date asked for, else where it was left, else the latest message. */
  start: ListStart;
}

export type ConversationState =
  | { status: 'loading' }
  | { status: 'ready'; conversation: OpenConversation }
  | { status: 'not-found' }
  | { status: 'error' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `date` is a calendar day as written in `?date=`; anything else is ignored. */
export const isDateParam = (value: string | null): value is string => {
  if (value === null || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  // Round-trip: Date.parse rolls 2026-02-30 over to March, the database rejects it.
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
};

/**
 * Opens one conversation for the view. An id that is missing, malformed or unknown is
 * `not-found` (a calm screen), not an error. `findOffset` jumps by date with the same use case.
 */
export function useConversation(id: string | null, date: string | null): { state: ConversationState; findOffset(date: string): Promise<number | null>; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [result, setResult] = useState<{ key: string; state: ConversationState }>({ key: '', state: { status: 'loading' } });
  const [attempt, setAttempt] = useState(0);
  const key = `${id}|${date}|${attempt}`;

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    const settle = (state: ConversationState) => alive && setResult({ key, state });
    (async () => {
      if (!isUuid(id)) return settle({ status: 'not-found' });
      try {
        const view = await openConversationView(deps, id);
        const profiles = await listProfiles(deps, 'all');
        const byId = new Map(profiles.map((p) => [p.id, p.displayName]));
        const people = view.conversation.profileIds.flatMap((pid) => (byId.has(pid) ? [{ id: pid, name: byId.get(pid)! }] : []));
        const count = view.bounds.count;
        let start: ListStart = { kind: 'end' };
        const offset = isDateParam(date) && count > 0 ? await findMessageOffsetByDate(deps, id, date) : null;
        if (offset !== null) start = { kind: 'index', index: offset };
        else {
          const saved = isDateParam(date) ? undefined : loadPosition(id, count);
          if (saved) start = { kind: 'index', index: saved.index, within: saved.within };
        }
        settle({ status: 'ready', conversation: { view, people, start } });
      } catch (error) {
        settle({ status: (error as { code?: string }).code === 'not-found' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, id, date, key]);

  const findOffset = useCallback((day: string) => (deps && isUuid(id) ? findMessageOffsetByDate(deps, id, day) : Promise.resolve(null)), [deps, id]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === key ? result.state : { status: 'loading' }, findOffset, retry };
}
