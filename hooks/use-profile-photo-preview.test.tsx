import { afterEach, describe, expect, test } from 'vitest';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { NewPhotoItem } from '@/lib/domain/photo';
import { assignPhotos } from '@/lib/usecases/photo-assign';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import { PHOTO_PREVIEW_COUNT, useProfilePhotoPreview, type ProfilePhotoPreview } from './use-profile-photo-preview';

const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const item = (n: number): NewPhotoItem => ({
  sha256: hash(n),
  kind: 'photo',
  mime: 'image/jpeg',
  takenAt: `2026-03-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
  takenOffsetMinutes: null,
  dateSource: 'exif-local',
  latitude: null,
  longitude: null,
  description: '',
  album: '',
  fileName: `${n}.jpg`,
});

let seen: ProfilePhotoPreview | undefined;
function Probe({ id }: { id: string | null }) {
  useLibrary();
  seen = useProfilePhotoPreview(id);
  return null;
}

describe('useProfilePhotoPreview', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('the newest few pictures and the whole count', async () => {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    const numbers = [1, 2, 3, 4, 5, 6];
    await lib.client.call('importPhotoItems', {
      batchId: '00000000-0000-4000-8000-000000000501',
      source: 'takeout',
      sourceLabel: 'trip.zip',
      now: '2026-03-01T10:00:00Z',
      blobs: numbers.map((n) => ({ sha256: hash(n), size: 1, mime: null })),
      items: numbers.map(item),
    });
    await assignPhotos(lib.deps, { sha256s: numbers.map(hash), profileIds: [ana.id] });
    view = await renderWithLibrary(<Probe id={ana.id} />, { lib });
    await settle();
    if (seen?.status !== 'ready') throw new Error(String(seen?.status));
    expect(seen.total).toBe(6);
    expect(seen.pictures).toHaveLength(PHOTO_PREVIEW_COUNT);
    expect(seen.pictures.map((p) => p.sha256)).toEqual([6, 5, 4, 3].map(hash));
  });

  test('a profile with none is ready with a total of 0; a bad id stays loading', async () => {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    view = await renderWithLibrary(<Probe id={ana.id} />, { lib });
    await settle();
    expect(seen).toEqual({ status: 'ready', total: 0, pictures: [] });
    view.unmount();
    view = await renderWithLibrary(<Probe id="not-an-id" />, { lib });
    await settle();
    expect(seen).toEqual({ status: 'loading' });
  });
});
