'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUuid, type Note, type NoteItem } from '@/lib/domain/library';
import { countNotes, listNotes } from '@/lib/usecases/notes';
import { useLibraryInternals } from './use-library';

/** How many notes one step reads and shows. */
export const PERSON_NOTES_PAGE = 50;

export type PersonNotesState =
  | { status: 'loading' }
  | { status: 'ready'; items: NoteItem[]; total: number; loadingMore: boolean; moreFailed: boolean }
  | { status: 'not-found' }
  | { status: 'error' };

/** The list's own key for a note: what it is attached to. */
export const noteItemKey = (item: NoteItem): string =>
  item.kind === 'profile' ? `p:${item.profileId}` : item.kind === 'conversation' ? `c:${item.conversationId}` : `m:${item.conversationId}:${item.message?.id}`;

/**
 * The notes of a person (their own, those on their conversations and on messages in them), most
 * recently edited first, `PERSON_NOTES_PAGE` at a time. A missing, malformed or unknown id is
 * `not-found`; a failed first read is `error` (`retry`); a failed later page keeps what is shown and
 * sets `moreFailed`. `changed` applies a saved note (or `null`: deleted) to the list in place, so
 * nothing is read again and the list does not jump; later pages are read from the number shown.
 */
export function usePersonNotes(profileId: string | null): {
  state: PersonNotesState;
  loadMore(): void;
  retry(): void;
  changed(item: NoteItem, note: Note | null): void;
} {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [attempt, setAttempt] = useState(0);
  const runKey = `${profileId}|${attempt}`;
  const [result, setResult] = useState<{ key: string; state: PersonNotesState }>({ key: '', state: { status: 'loading' } });
  const busy = useRef(false);
  const latest = useRef({ key: '', result });
  latest.current = { key: latest.current.key, result };

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    latest.current.key = runKey;
    busy.current = false;
    const settle = (state: PersonNotesState) => alive && setResult({ key: runKey, state });
    (async () => {
      if (!isUuid(profileId)) return settle({ status: 'not-found' });
      try {
        const scope = { profileId };
        const [total, items] = await Promise.all([countNotes(deps, scope), listNotes(deps, scope, 0, PERSON_NOTES_PAGE)]);
        settle({ status: 'ready', items, total, loadingMore: false, moreFailed: false });
      } catch (error) {
        const code = (error as { code?: string }).code;
        settle({ status: code === 'not-found' || code === 'invalid' ? 'not-found' : 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, profileId, runKey]);

  const loadMore = useCallback(() => {
    const shown = latest.current.result;
    if (!deps || busy.current || shown.key !== latest.current.key || shown.state.status !== 'ready') return;
    const { items, total } = shown.state;
    if (items.length >= total || !isUuid(profileId)) return;
    const mine = latest.current.key;
    busy.current = true;
    setResult({ key: mine, state: { ...shown.state, loadingMore: true, moreFailed: false } });
    listNotes(deps, { profileId }, items.length, PERSON_NOTES_PAGE).then(
      (page) => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, items: [...now.state.items, ...page], loadingMore: false } } : now));
      },
      () => {
        busy.current = false;
        setResult((now) => (now.key === mine && now.state.status === 'ready' ? { key: mine, state: { ...now.state, loadingMore: false, moreFailed: true } } : now));
      },
    );
  }, [deps, profileId]);

  const changed = useCallback((item: NoteItem, note: Note | null) => {
    const key = noteItemKey(item);
    const mine = latest.current.key;
    setResult((now) => {
      if (now.key !== mine || now.state.status !== 'ready') return now;
      const items = note
        ? now.state.items.map((i) => (noteItemKey(i) === key ? { ...i, body: note.body, updatedAt: note.updatedAt } : i))
        : now.state.items.filter((i) => noteItemKey(i) !== key);
      return { key: mine, state: { ...now.state, items, total: note ? now.state.total : Math.max(0, now.state.total - 1) } };
    });
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: deps && result.key === runKey ? result.state : { status: 'loading' }, loadMore, retry, changed };
}
