'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PROFILE_DESCRIPTION_MAX } from '@/lib/domain/profile';
import { openConversationView } from '@/lib/usecases/conversation-view';
import { listProfiles } from '@/lib/usecases/profiles';
import { useLibraryInternals } from './use-library';
import { useProfileActions } from './use-people';

/** The person a conversation is filed under, and the phrase they have now ('' when none). */
export interface PhraseTarget {
  id: string;
  name: string;
  phrase: string;
}

export type PhraseTargetState = { status: 'idle' | 'loading' | 'none' | 'error' } | { status: 'ready'; target: PhraseTarget };

/**
 * Who a message's phrase would go to: the person named by `preferred` when the conversation is kept
 * under them, else the first person it is kept under. Nothing is read until `enabled`; reloaded when
 * a profile changes so the current phrase is never stale.
 */
export function usePhraseTarget(conversationId: string, enabled: boolean, preferred: string | null): PhraseTargetState {
  const { state, register } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [result, setResult] = useState<PhraseTargetState>({ status: 'idle' });
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!deps || !enabled) return;
    const mine = ++latest.current;
    const settle = (next: PhraseTargetState) => {
      if (mine === latest.current) setResult(next);
    };
    try {
      const { conversation } = await openConversationView(deps, conversationId);
      const profiles = await listProfiles(deps, 'all');
      const linked = conversation.profileIds.flatMap((id) => profiles.filter((p) => p.id === id));
      const chosen = linked.find((p) => p.id === preferred) ?? linked[0];
      settle(chosen ? { status: 'ready', target: { id: chosen.id, name: chosen.displayName, phrase: chosen.description } } : { status: 'none' });
    } catch {
      settle({ status: 'error' });
    }
  }, [deps, enabled, conversationId, preferred]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [enabled, load, register]);

  return result;
}

/**
 * A message body as a phrase: trimmed, stray control characters dropped and cut to the length a
 * description may have without splitting a character (a surrogate pair stays whole). '' for a body
 * with nothing to show.
 */
export function phraseFromBody(body: string): string {
  const clean = body.replace(/[^\P{Cc}\t\n\r]/gu, '').trim();
  let out = '';
  for (const char of clean) {
    if (out.length + char.length > PROFILE_DESCRIPTION_MAX) break;
    out += char;
  }
  return out.trim();
}

/** Makes a message the phrase of a person. Resolves after it is stored and the screens have reloaded. */
export function useSetPhrase(): (personId: string, body: string) => Promise<void> {
  const { update } = useProfileActions();
  return useCallback(
    async (personId, body) => {
      const description = phraseFromBody(body);
      if (!description) throw new Error('nothing to use as a phrase');
      await update(personId, { description });
    },
    [update],
  );
}
