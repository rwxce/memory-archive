'use client';

import { useCallback, useEffect, useState } from 'react';
import { isUuid } from '@/lib/domain/library';
import { getPersonDetails } from '@/lib/usecases/library';
import { openConversationView } from '@/lib/usecases/conversation-view';
import type { SearchScope } from '@/lib/usecases/search';
import { useLibraryInternals } from './use-library';

export type SearchScopeState =
  | { status: 'loading' }
  /** `label` is the person's name or the conversation's title; `null` when searching everything. */
  | { status: 'ready'; scope: SearchScope; label: string | null; kind: 'all' | 'person' | 'conversation'; id: string | null }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * Where a search looks, from the address: nothing (everything), `?person=` or `?conversation=`.
 * Both at once, a malformed id or an id that matches nothing is `not-found`. The name or title is
 * read here so the screen can say where it is searching.
 */
export function useSearchScope(person: string | null, conversation: string | null): { state: SearchScopeState; retry(): void } {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = `${person}|${conversation}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: SearchScopeState }>({ key: '', state: { status: 'loading' } });

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    const settle = (state: SearchScopeState) => alive && setResult({ key, state });
    (async () => {
      if (person === null && conversation === null) return settle({ status: 'ready', scope: undefined, label: null, kind: 'all', id: null });
      if (person !== null && conversation !== null) return settle({ status: 'not-found' });
      try {
        if (person !== null) {
          if (!isUuid(person)) return settle({ status: 'not-found' });
          const details = await getPersonDetails(deps, person);
          if (!details) return settle({ status: 'not-found' });
          return settle({ status: 'ready', scope: { profileId: person }, label: details.person.displayName, kind: 'person', id: person });
        }
        if (!isUuid(conversation)) return settle({ status: 'not-found' });
        const view = await openConversationView(deps, conversation);
        settle({ status: 'ready', scope: { conversationId: conversation }, label: view.conversation.title, kind: 'conversation', id: conversation });
      } catch (error) {
        settle({ status: (error as { code?: string }).code === 'not-found' || (error as { code?: string }).code === 'invalid' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, person, conversation, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === key ? result.state : { status: 'loading' }, retry };
}
