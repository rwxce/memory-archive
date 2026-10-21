'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listPeople, type People } from '@/lib/usecases/library';
import {
  archiveProfile,
  createProfile,
  unarchiveProfile,
  updateProfile,
  type NewProfile,
  type ProfilePatch,
} from '@/lib/usecases/profiles';
import type { Profile } from '@/lib/domain/library';
import { useLibraryInternals } from './use-library';

export type PeopleState = { status: 'loading' } | { status: 'ready'; people: People } | { status: 'error' };

/** Everyone in the library; reloaded when `useProfileActions` finishes a change. */
export function usePeople(): PeopleState {
  const { state, register } = useLibraryInternals();
  const [result, setResult] = useState<PeopleState>({ status: 'loading' });
  const deps = state.status === 'ready' ? state.deps : undefined;
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!deps) return;
    const mine = ++latest.current;
    try {
      const people = await listPeople(deps);
      if (mine === latest.current) setResult({ status: 'ready', people });
    } catch {
      if (mine === latest.current) setResult({ status: 'error' });
    }
  }, [deps]);

  useEffect(() => {
    void load();
    const unregister = register(load);
    return () => {
      latest.current++;
      unregister();
    };
  }, [load, register]);

  return deps ? result : { status: 'loading' };
}

export interface ProfileActions {
  create(input: NewProfile): Promise<Profile>;
  update(id: string, patch: ProfilePatch): Promise<Profile>;
  archive(id: string): Promise<Profile>;
  unarchive(id: string): Promise<Profile>;
}

/** Writes to profiles. Each one resolves after the change is stored and the lists on screen have reloaded. */
export function useProfileActions(): ProfileActions {
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
      create: async (input) => after(createProfile(ready(), input)),
      update: async (id, patch) => after(updateProfile(ready(), id, patch)),
      archive: async (id) => after(archiveProfile(ready(), id)),
      unarchive: async (id) => after(unarchiveProfile(ready(), id)),
    };
  }, [deps, after]);
}
