'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPersonDetails, type PersonDetails } from '@/lib/usecases/library';
import { useLibraryInternals } from './use-library';

export type PersonDetailsState =
  | { status: 'loading' }
  | { status: 'ready'; details: PersonDetails }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * One person and their conversations; reloaded when an action finishes. An id
 * that matches no one (or is missing or malformed) is `not-found`, not an error.
 */
export function usePersonDetails(id: string | null): PersonDetailsState {
  const { state, register } = useLibraryInternals();
  const [result, setResult] = useState<{ id: string | null; state: PersonDetailsState }>({ id, state: { status: 'loading' } });
  const deps = state.status === 'ready' ? state.deps : undefined;
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    const settle = (next: PersonDetailsState) => {
      if (mine === latest.current) setResult({ id, state: next });
    };
    try {
      const details = await getPersonDetails(deps, id ?? '');
      settle(details ? { status: 'ready', details } : { status: 'not-found' });
    } catch {
      settle({ status: 'error' });
    }
  }, [deps, id]);

  useEffect(() => {
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [load, register]);

  // A result for another id (the address changed) is stale: show loading until the new one arrives.
  return deps && result.id === id ? result.state : { status: 'loading' };
}
