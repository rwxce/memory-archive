'use client';

import { useEffect, useState } from 'react';
import { isUuid } from '@/lib/domain/library';
import type { PhotoPicture } from '@/lib/domain/photo';
import { countProfilePhotos, listProfilePhotos } from '@/lib/usecases/photo-assign';
import { useLibraryInternals } from './use-library';

/** How many pictures the person's page previews in its Photos card. */
export const PHOTO_PREVIEW_COUNT = 4;

export type ProfilePhotoPreview = { status: 'loading' | 'error' } | { status: 'ready'; total: number; pictures: PhotoPicture[] };

/**
 * The first few pictures assigned to a profile and how many it has, for the Photos card on the person's page. A failure
 * (`error`) leaves the card without a preview; it never blocks the rest of the page.
 */
export function useProfilePhotoPreview(profileId: string | null): ProfilePhotoPreview {
  const { state } = useLibraryInternals();
  const deps = state.status === 'ready' ? state.deps : undefined;
  const [result, setResult] = useState<{ id: string; preview: ProfilePhotoPreview }>({ id: '', preview: { status: 'loading' } });

  useEffect(() => {
    if (!deps || !isUuid(profileId)) return;
    let alive = true;
    Promise.all([countProfilePhotos(deps, profileId), listProfilePhotos(deps, profileId, { limit: PHOTO_PREVIEW_COUNT })]).then(
      ([total, page]) => alive && setResult({ id: profileId, preview: { status: 'ready', total, pictures: page.pictures } }),
      () => alive && setResult({ id: profileId, preview: { status: 'error' } }),
    );
    return () => {
      alive = false;
    };
  }, [deps, profileId]);

  return deps && isUuid(profileId) && result.id === profileId ? result.preview : { status: 'loading' };
}
