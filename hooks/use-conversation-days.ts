'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConversationDay } from '@/lib/domain/library';

export type ConversationDaysState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; days: ConversationDay[] }
  | { status: 'error' };

/**
 * The days of a feed (a conversation, a person's timeline; `listDays` must be stable) that have messages, for the calendar. Nothing is read until
 * `enabled` is first true (the calendar opened), so opening a conversation does not pay for it;
 * once read, the days are kept while the screen lives. Closing before the read ends cancels it
 * and the next opening reads again. `retry` reads again after a failure.
 */
export function useConversationDays(listDays: () => Promise<ConversationDay[]>, enabled: boolean): { state: ConversationDaysState; retry(): void } {
  const [result, setResult] = useState<{ status: 'ready'; days: ConversationDay[] } | { status: 'error' } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wanted = enabled && result === null;

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    listDays().then(
      (days) => alive && setResult({ status: 'ready', days }),
      () => alive && setResult({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
    // `attempt` re-runs the read after a retry.
  }, [wanted, listDays, attempt]);

  const retry = useCallback(() => {
    setResult(null);
    setAttempt((n) => n + 1);
  }, []);
  return { state: result ?? (enabled ? { status: 'loading' } : { status: 'idle' }), retry };
}
