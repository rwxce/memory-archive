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
import { getProfilePhoto, removeProfilePhoto, setProfilePhoto } from '@/lib/usecases/profile-photo';
import type { Profile } from '@/lib/domain/library';
import { useLibraryInternals } from './use-library';

/**
 * A profile's photo as an object URL (revoked when it changes or the avatar goes away), or `null`
 * while loading, when there is none, or when it cannot be read: the avatar then shows initials.
 * `photoSha256` is the cache key, so a replaced photo reloads.
 */
export function useProfilePhotoUrl(profileId: string, photoSha256: string | null): string | null {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!deps || !photoSha256) {
      setUrl(null);
      return;
    }
    let alive = true;
    let made: string | undefined;
    setUrl(null);
    getProfilePhoto(deps, profileId).then(
      (blob) => {
        if (!alive) return;
        if (!blob) {
          setUrl(null);
          return;
        }
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [deps, profileId, photoSha256]);
  return photoSha256 ? url : null;
}

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

/** What the person chose to do with a profile's photo in the form. */
export type PhotoChange = { kind: 'keep' } | { kind: 'set'; file: Blob } | { kind: 'remove' };

export interface ProfileActions {
  create(input: NewProfile): Promise<Profile>;
  update(id: string, patch: ProfilePatch): Promise<Profile>;
  archive(id: string): Promise<Profile>;
  unarchive(id: string): Promise<Profile>;
  /** Stores, replaces or removes the photo; `keep` does nothing. Rejects with a `DbError`; the profile itself is untouched by a failure. */
  applyPhoto(id: string, change: PhotoChange): Promise<void>;
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
      applyPhoto: async (id, change) => {
        if (change.kind === 'keep') return;
        await after(change.kind === 'set' ? setProfilePhoto(ready(), id, change.file) : removeProfilePhoto(ready(), id));
      },
    };
  }, [deps, after]);
}
