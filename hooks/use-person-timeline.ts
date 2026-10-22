'use client';

import { useCallback, useEffect, useState } from 'react';
import { isUuid, type ConversationBounds } from '@/lib/domain/library';
import { getPersonDetails } from '@/lib/usecases/library';
import { findPersonTimelineOffsetByDate, getPersonTimelineBounds } from '@/lib/usecases/person-timeline';
import { loadPosition } from './conversation-position';
import { isDateParam } from './use-conversation';
import { useLibraryInternals } from './use-library';
import type { ListStart } from './use-virtual-list';

export interface OpenTimeline {
  person: { id: string; name: string };
  bounds: ConversationBounds;
  /** How many conversations are filed under the person. */
  conversations: number;
  /** Where to open: the date asked for, else where it was left, else the latest message. */
  start: ListStart;
}

export type PersonTimelineState = { status: 'loading' } | { status: 'ready'; timeline: OpenTimeline } | { status: 'not-found' } | { status: 'error' };

/** Key of a person's timeline in the saved reading positions (apart from any conversation's id). */
export const timelinePositionKey = (personId: string) => `timeline:${personId}`;

/**
 * Opens a person's combined timeline: who they are, how many messages across how many
 * conversations, and where to start. A missing, malformed or unknown id is `not-found` (a calm
 * screen), not an error.
 */
export function usePersonTimeline(id: string | null, date: string | null): { state: PersonTimelineState; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [result, setResult] = useState<{ key: string; state: PersonTimelineState }>({ key: '', state: { status: 'loading' } });
  const [attempt, setAttempt] = useState(0);
  const key = `${id}|${date}|${attempt}`;

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    const settle = (state: PersonTimelineState) => alive && setResult({ key, state });
    (async () => {
      if (!isUuid(id)) return settle({ status: 'not-found' });
      try {
        const details = await getPersonDetails(deps, id);
        if (!details) return settle({ status: 'not-found' });
        const bounds = await getPersonTimelineBounds(deps, id);
        let start: ListStart = { kind: 'end' };
        const offset = isDateParam(date) && bounds.count > 0 ? await findPersonTimelineOffsetByDate(deps, id, date) : null;
        if (offset !== null) start = { kind: 'index', index: offset };
        else {
          const saved = isDateParam(date) ? undefined : loadPosition(timelinePositionKey(id), bounds.count);
          if (saved) start = { kind: 'index', index: saved.index, within: saved.within };
        }
        settle({
          status: 'ready',
          timeline: { person: { id, name: details.person.displayName }, bounds, conversations: details.conversations.length, start },
        });
      } catch (error) {
        settle({ status: (error as { code?: string }).code === 'not-found' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, id, date, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === key ? result.state : { status: 'loading' }, retry };
}
