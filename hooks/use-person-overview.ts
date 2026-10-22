'use client';

import { useEffect, useState } from 'react';
import { isUuid, type PersonMediaItem, type PersonTimelineMessage } from '@/lib/domain/library';
import { countFavorites, listFavorites } from '@/lib/usecases/favorites';
import { countNotes } from '@/lib/usecases/notes';
import { countPersonMedia, listPersonMedia } from '@/lib/usecases/person-media';
import { getPersonTimelineBounds, listPersonTimelineDays } from '@/lib/usecases/person-timeline';
import { useLibraryInternals } from './use-library';

/** How many gallery thumbnails and favorite excerpts the person's page previews. */
export const OVERVIEW_THUMBS = 6;
export const OVERVIEW_FAVORITES = 2;

export interface PersonOverview {
  messages: number;
  /** Photos and videos. */
  pictures: number;
  voice: number;
  favorites: number;
  notes: number;
  /** Messages per year, oldest first. */
  years: { year: number; count: number }[];
  /** The first photos (not videos), for the gallery tile. */
  thumbs: PersonMediaItem[];
  /** The first favorites, for the excerpts. */
  excerpts: PersonTimelineMessage[];
}

export type PersonOverviewState = { status: 'loading' } | { status: 'ready'; overview: PersonOverview } | { status: 'error' };

/**
 * What a person's page previews besides their profile: counts, messages per year, a few photos and
 * favorites. Read through the existing use cases once the library is ready; a failure leaves the
 * page without previews (`error`), it never blocks the rest of the page.
 */
export function usePersonOverview(profileId: string | null): PersonOverviewState {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [result, setResult] = useState<{ id: string; state: PersonOverviewState }>({ id: '', state: { status: 'loading' } });

  useEffect(() => {
    if (!deps || !isUuid(profileId)) return;
    let alive = true;
    (async () => {
      try {
        const scope = { profileId };
        const [bounds, pictures, voice, favorites, notes, days, thumbs, excerpts] = await Promise.all([
          getPersonTimelineBounds(deps, profileId),
          countPersonMedia(deps, profileId, ['photo', 'video']),
          countPersonMedia(deps, profileId, ['audio']),
          countFavorites(deps, scope),
          countNotes(deps, scope),
          listPersonTimelineDays(deps, profileId),
          listPersonMedia(deps, profileId, ['photo'], 0, OVERVIEW_THUMBS),
          listFavorites(deps, scope, 0, OVERVIEW_FAVORITES),
        ]);
        const perYear = new Map<number, number>();
        for (const day of days) {
          const year = Number(day.date.slice(0, 4));
          perYear.set(year, (perYear.get(year) ?? 0) + day.count);
        }
        const years = [...perYear].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
        if (alive) setResult({ id: profileId, state: { status: 'ready', overview: { messages: bounds.count, pictures, voice, favorites, notes, years, thumbs, excerpts } } });
      } catch {
        if (alive) setResult({ id: profileId, state: { status: 'error' } });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deps, profileId]);

  return deps && isUuid(profileId) && result.id === profileId ? result.state : { status: 'loading' };
}
