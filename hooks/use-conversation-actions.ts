'use client';

import { useCallback, useMemo } from 'react';
import type { ConversationSummary } from '@/lib/domain/library';
import {
  linkConversationToProfile,
  moveConversation,
  renameConversation,
  unlinkConversationFromProfile,
} from '@/lib/usecases/conversations';
import { useLibraryInternals } from './use-library';

export interface ConversationActions {
  rename(conversationId: string, title: string): Promise<ConversationSummary>;
  move(conversationId: string, fromProfileId: string, toProfileId: string): Promise<ConversationSummary>;
  link(conversationId: string, profileId: string): Promise<ConversationSummary>;
  unlink(conversationId: string, profileId: string): Promise<ConversationSummary>;
}

/** Changes to conversations. Each resolves after the change is stored and the lists on screen have reloaded. */
export function useConversationActions(): ConversationActions {
  const { state, refresh } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const after = useCallback(
    async <T,>(work: Promise<T>): Promise<T> => {
      const value = await work;
      await refresh();
      return value;
    },
    [refresh],
  );
  return useMemo(() => {
    const ready = () => {
      if (!deps) throw new Error('the library is not open');
      return deps;
    };
    return {
      rename: async (id, title) => after(renameConversation(ready(), id, title)),
      move: async (id, from, to) => after(moveConversation(ready(), id, from, to)),
      link: async (id, profileId) => after(linkConversationToProfile(ready(), id, profileId)),
      unlink: async (id, profileId) => after(unlinkConversationFromProfile(ready(), id, profileId)),
    };
  }, [deps, after]);
}
