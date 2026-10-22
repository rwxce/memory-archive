'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConversationDay } from '@/lib/domain/library';
import { listConversationDays } from '@/lib/usecases/conversation-view';
import { useLibraryInternals } from './use-library';

export type ConversationDaysState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; days: ConversationDay[] }
  | { status: 'error' };

/**
 * The days of a conversation that have messages, for the calendar. Nothing is read until
 * `enabled` is first true (the calendar opened), so opening a conversation does not pay for it;
 * once read, the days are kept while the screen lives. Closing before the read ends cancels it
 * and the next opening reads again. `retry` reads again after a failure.
 */
export function useConversationDays(conversationId: string, enabled: boolean): { state: ConversationDaysState; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [result, setResult] = useState<{ status: 'ready'; days: ConversationDay[] } | { status: 'error' } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wanted = enabled && deps !== undefined && result === null;

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    listConversationDays(deps!, conversationId).then(
      (days) => alive && setResult({ status: 'ready', days }),
      () => alive && setResult({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
    // `attempt` re-runs the read after a retry.
  }, [wanted, deps, conversationId, attempt]);

  const retry = useCallback(() => {
    setResult(null);
    setAttempt((n) => n + 1);
  }, []);
  return { state: result ?? (enabled ? { status: 'loading' } : { status: 'idle' }), retry };
}
