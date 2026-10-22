'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageSource } from '@/lib/domain/library';
import { getMessageSource } from '@/lib/usecases/conversation-view';
import { useLibraryInternals } from './use-library';

export type MessageSourceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; source: MessageSource }
  | { status: 'not-found' }
  | { status: 'error' };

type Settled = Exclude<MessageSourceState, { status: 'idle' | 'loading' }>;

/**
 * Where one message came from, read lazily: nothing is read until `enabled` is first true (the
 * person opened the details). A result that is known stays, so closing and reopening does not read
 * again; a failure can be retried. A message that is gone (`not-found`) is a state, not an error.
 */
export function useMessageSource(conversationId: string, messageId: number, enabled: boolean): { state: MessageSourceState; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [result, setResult] = useState<Settled>();
  const [attempt, setAttempt] = useState(0);
  const settled = useRef(false);

  useEffect(() => {
    if (!enabled || !deps || settled.current) return;
    let current = true;
    getMessageSource(deps, conversationId, messageId).then(
      (source) => {
        if (!current) return;
        settled.current = true;
        setResult({ status: 'ready', source });
      },
      (error: unknown) => {
        if (!current) return;
        if ((error as { code?: string }).code === 'not-found') settled.current = true;
        setResult((error as { code?: string }).code === 'not-found' ? { status: 'not-found' } : { status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, deps, conversationId, messageId, attempt]);

  const retry = useCallback(() => {
    settled.current = false;
    setResult(undefined);
    setAttempt((n) => n + 1);
  }, []);

  return { state: result ?? (enabled ? { status: 'loading' } : { status: 'idle' }), retry };
}
