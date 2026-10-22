'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ConversationMessage } from '@/lib/domain/library';
import { setFavorite } from '@/lib/usecases/favorites';
import { messageKey } from './message-pages';
import { useLibraryDeps } from './use-library';

/**
 * The star on a message row. `toggle(message)` flips the mark at once in the paged cache (`mark`),
 * writes it, and puts the old mark back if the write fails (`onFailed` says so, calmly). While a
 * write for a message is running, further taps on that message are ignored, so the mark in the cache
 * and the stored one cannot drift apart. `feedId` is the conversation id of a conversation feed (the
 * rows of a person's timeline carry their own).
 */
export function useFavoriteToggle(feedId: string, mark: (message: ConversationMessage, favorite: boolean) => void, onFailed: () => void): (message: ConversationMessage) => void {
  const deps = useLibraryDeps();
  const running = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return useCallback(
    (message) => {
      if (!deps) return;
      const key = messageKey(feedId, message);
      if (running.current.has(key)) return;
      const conversationId = 'conversationId' in message ? String((message as { conversationId: unknown }).conversationId) : feedId;
      const next = !message.isFavorite;
      running.current.add(key);
      mark(message, next);
      setFavorite(deps, conversationId, message.id, next).then(
        () => {
          running.current.delete(key);
        },
        () => {
          running.current.delete(key);
          mark(message, !next);
          if (alive.current) onFailed();
        },
      );
    },
    [deps, feedId, mark, onFailed],
  );
}
