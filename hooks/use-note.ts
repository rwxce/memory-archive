'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, NoteTarget } from '@/lib/domain/library';
import { getNote, setNote } from '@/lib/usecases/notes';
import { useLibraryInternals } from './use-library';

export type NoteState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; note: Note | null } | { status: 'error' };

/** `saved` carries the stored note (`null` when an empty text deleted it); `invalid` is a text the archive refuses. */
export type SaveResult = { status: 'saved'; note: Note | null } | { status: 'invalid' } | { status: 'failed' };

export interface NoteController {
  state: NoteState;
  retry(): void;
  save(body: string): Promise<SaveResult>;
}

/** Identifies a target, so a changed target reads again. */
const keyOf = (target: NoteTarget): string =>
  target.kind === 'profile' ? `p:${target.profileId}` : target.kind === 'conversation' ? `c:${target.conversationId}` : `m:${target.conversationId}:${target.messageId}`;

/**
 * The note on one target, read lazily: nothing is read until `enabled` is first true. `initial` is a
 * note the caller already has (a list), so no read is needed. A known result stays, so closing and
 * reopening does not read again; a failed read can be retried. `save` stores the text (an empty text
 * deletes the note), keeps the stored note as the state and calls `onChanged` even if the caller has
 * gone by then, so a cached `hasNote` never drifts from the stored one. A second `save` while one runs
 * is a `failed` that changed nothing.
 */
export function useNote(target: NoteTarget, enabled: boolean, options: { initial?: Note | null; onChanged?: (note: Note | null) => void } = {}): NoteController {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const key = keyOf(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  const onChanged = useRef(options.onChanged);
  onChanged.current = options.onChanged;
  const [result, setResult] = useState<{ key: string; state: Exclude<NoteState, { status: 'idle' | 'loading' }> }>();
  const [attempt, setAttempt] = useState(0);
  const saving = useRef(false);

  const known = result?.key === key ? result.state : options.initial !== undefined ? ({ status: 'ready', note: options.initial } as const) : undefined;
  const settled = known?.status === 'ready';

  useEffect(() => {
    if (!enabled || !deps || settled) return;
    let current = true;
    getNote(deps, targetRef.current).then(
      (note) => current && setResult({ key, state: { status: 'ready', note } }),
      () => current && setResult({ key, state: { status: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [enabled, deps, key, settled, attempt]);

  const retry = useCallback(() => {
    setResult(undefined);
    setAttempt((n) => n + 1);
  }, []);

  const save = useCallback(
    async (body: string): Promise<SaveResult> => {
      if (!deps || saving.current) return { status: 'failed' };
      saving.current = true;
      try {
        const note = await setNote(deps, targetRef.current, body);
        setResult({ key, state: { status: 'ready', note } });
        onChanged.current?.(note);
        return { status: 'saved', note };
      } catch (error) {
        return { status: (error as { code?: string }).code === 'invalid' ? 'invalid' : 'failed' };
      } finally {
        saving.current = false;
      }
    },
    [deps, key],
  );

  const state: NoteState = known ?? (enabled ? { status: 'loading' } : { status: 'idle' });
  return useMemo(() => ({ state, retry, save }), [state, retry, save]);
}
