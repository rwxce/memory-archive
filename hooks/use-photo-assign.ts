'use client';

import { useCallback, useRef, useState } from 'react';
import type { PhotoPicture } from '@/lib/domain/photo';
import { assignPhotos, getPhotoPicture, unassignPhotoLinks, unassignPhotos, type PhotoProfileLinks } from '@/lib/usecases/photo-assign';
import { retryWhileBusy } from './retry-busy';
import { useLibraryInternals } from './use-library';

export type AssignOutcome =
  | {
      kind: 'assigned';
      added: number;
      alreadyThere: number;
      pictureCount: number;
      /** Exactly the links this call inserted (the database says so); absent when there were too many to carry, so there is no undo. */
      fresh: PhotoProfileLinks[] | undefined;
    }
  | { kind: 'undone'; removed: number }
  /** `gone`: chosen pictures that are no longer in the collection (found after a failure), so the choice can be corrected. */
  | { kind: 'failed'; what: 'assign' | 'undo'; gone?: string[] };

/** Pictures looked up at once when a failure makes us check the choice. */
const CHECK_BATCH = 50;

export interface PhotoAssignActions {
  working: boolean;
  /** Assigns exactly these pictures to exactly these profiles. Never rejects: a failure is an outcome. */
  assign(pictures: readonly PhotoPicture[], profileIds: readonly string[]): Promise<AssignOutcome>;
  /** Takes back what `assign` added. */
  undo(fresh: readonly PhotoProfileLinks[]): Promise<AssignOutcome>;
  /** Takes one picture out of one profile; false when it failed. */
  unassignOne(sha256: string, profileId: string): Promise<boolean>;
}

/** Writes assignments through the use cases, one at a time. */
export function usePhotoAssign(): PhotoAssignActions {
  const { state, refresh } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [working, setWorking] = useState(false);
  const busy = useRef(false);

  const guarded = useCallback(
    async <T,>(fallback: T, work: () => Promise<T>): Promise<T> => {
      if (!deps || busy.current) return fallback;
      busy.current = true;
      setWorking(true);
      try {
        return await work();
      } catch {
        return fallback;
      } finally {
        busy.current = false;
        setWorking(false);
        void refresh();
      }
    },
    [deps, refresh],
  );

  const assign = useCallback<PhotoAssignActions['assign']>(
    (pictures, profileIds) =>
      guarded<AssignOutcome>({ kind: 'failed', what: 'assign' }, async () => {
        const sha256s = pictures.map((p) => p.sha256);
        try {
          const result = await retryWhileBusy(() => assignPhotos(deps!, { sha256s, profileIds: [...profileIds] }));
          return { kind: 'assigned', added: result.added, alreadyThere: result.alreadyThere, pictureCount: pictures.length, fresh: result.fresh ?? undefined };
        } catch {
          // Whatever went wrong, nothing was written. Which of the chosen pictures are gone (taken out of the collection in another tab)?
          // They would make every retry fail the same way.
          const gone: string[] = [];
          try {
            for (let i = 0; i < sha256s.length; i += CHECK_BATCH) {
              const found = await Promise.all(sha256s.slice(i, i + CHECK_BATCH).map(async (sha256) => ((await getPhotoPicture(deps!, sha256)) === null ? sha256 : undefined)));
              gone.push(...found.filter((sha): sha is string => sha !== undefined));
            }
          } catch {
            // Cannot even look: report the failure as it is.
          }
          return { kind: 'failed', what: 'assign', gone };
        }
      }),
    [guarded, deps],
  );

  // One transaction with exactly the links the assignment added: it either all happens or nothing does, and a failure can be retried as it is.
  const undo = useCallback<PhotoAssignActions['undo']>(
    (fresh) =>
      guarded<AssignOutcome>({ kind: 'failed', what: 'undo' }, async () => {
        const { removed } = await retryWhileBusy(() => unassignPhotoLinks(deps!, [...fresh]));
        return { kind: 'undone', removed };
      }),
    [guarded, deps],
  );

  const unassignOne = useCallback<PhotoAssignActions['unassignOne']>(
    (sha256, profileId) => guarded(false, async () => (await retryWhileBusy(() => unassignPhotos(deps!, { sha256s: [sha256], profileId })), true)),
    [guarded, deps],
  );

  return { working, assign, undo, unassignOne };
}
