'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HighlightMessage } from '@/lib/domain/highlights';
import { listHighlightMessages } from '@/lib/usecases/highlights';
import { useLibraryInternals } from './use-library';

export type HighlightMessagesState = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; messages: HighlightMessage[] };

/** The messages of one highlight, read only once `enabled` (the card was expanded). */
export function useHighlightMessages(conversationId: string, highlightId: string, enabled: boolean): { state: HighlightMessagesState; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = `${conversationId}|${highlightId}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: HighlightMessagesState }>({ key: '', state: { status: 'idle' } });

  useEffect(() => {
    if (!deps || !enabled) return;
    let alive = true;
    listHighlightMessages(deps, conversationId, highlightId).then(
      (messages) => alive && setResult({ key, state: { status: 'ready', messages } }),
      () => alive && setResult({ key, state: { status: 'error' } }),
    );
    return () => {
      alive = false;
    };
  }, [deps, enabled, conversationId, highlightId, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: !enabled ? { status: 'idle' } : result.key === key ? result.state : { status: 'loading' }, retry };
}
