import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { NewPhotoItem } from '@/lib/domain/photo';
import { assignPhotos } from '@/lib/usecases/photo-assign';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import { scopeOf, usePhotoGrid, type PhotoGrid } from './use-photo-grid';

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
  album: 'Trip',
  fileName: `${n}.jpg`,
});

let seen: PhotoGrid | undefined;
function Probe({ profileId }: { profileId?: string }) {
  useLibrary();
  seen = usePhotoGrid('assigned', profileId);
  return null;
}

describe('scopeOf', () => {
  test('a profile narrows "assigned" to that profile; without one the filter is the scope', () => {
    expect(scopeOf('assigned', 'p1')).toEqual({ show: 'assigned', profileId: 'p1' });
    expect(scopeOf('assigned')).toEqual({ show: 'assigned' });
    expect(scopeOf('unassigned')).toEqual({ show: 'unassigned' });
  });
});

describe('usePhotoGrid with a profile', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  async function setup() {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    const bo = await createProfile(lib.deps, { displayName: 'Bo' });
    await lib.client.call('importPhotoItems', {
      batchId: '00000000-0000-4000-8000-000000000501',
      source: 'takeout',
      sourceLabel: 'trip.zip',
      now: '2026-03-01T10:00:00Z',
      blobs: [1, 2, 3, 4].map((n) => ({ sha256: hash(n), size: 1, mime: null })),
      items: [1, 2, 3, 4].map(item),
    });
    await assignPhotos(lib.deps, { sha256s: [hash(1), hash(2), hash(3)], profileIds: [ana.id] });
    await assignPhotos(lib.deps, { sha256s: [hash(4)], profileIds: [bo.id] });
    return { lib, ana, bo };
  }

  test('lists only that profile’s pictures (newest first) and counts them', async () => {
    const { lib, ana } = await setup();
    view = await renderWithLibrary(<Probe profileId={ana.id} />, { lib });
    await settle();
    expect(seen!.status).toBe('ready');
    expect(seen!.pictures.map((p) => p.sha256)).toEqual([hash(3), hash(2), hash(1)]);
    expect(seen!.profileTotal).toBe(3);
  });

  test('patch drops a picture taken out of the profile, and recount follows the database', async () => {
    const { lib, ana } = await setup();
    view = await renderWithLibrary(<Probe profileId={ana.id} />, { lib });
    await settle();
    await act(async () => seen!.patch((p) => (p.sha256 === hash(2) ? { ...p, assignedProfileIds: [] } : p)));
    expect(seen!.pictures.map((p) => p.sha256)).toEqual([hash(3), hash(1)]);
    // A picture that also belongs to someone else stays while it is still the profile's.
    await act(async () => seen!.patch((p) => (p.sha256 === hash(1) ? { ...p, assignedProfileIds: [...p.assignedProfileIds, 'someone-else'] } : p)));
    expect(seen!.pictures).toHaveLength(2);
    // The database was not touched, so the count still says 3 until the real change is made.
    await act(async () => seen!.recount());
    expect(seen!.profileTotal).toBe(3);
  });

  test('a profile with nothing is ready and empty with a total of 0', async () => {
    const { lib } = await setup();
    const cy = await createProfile(lib.deps, { displayName: 'Cy' });
    view = await renderWithLibrary(<Probe profileId={cy.id} />, { lib });
    await settle();
    expect(seen!.status).toBe('ready');
    expect(seen!.pictures).toEqual([]);
    expect(seen!.profileTotal).toBe(0);
  });

  test('without a profile the collection counts are read, not a profile total', async () => {
    const { lib } = await setup();
    view = await renderWithLibrary(<Probe />, { lib });
    await settle();
    expect(seen!.profileTotal).toBeUndefined();
    expect(seen!.counts?.pictures).toBe(4);
  });
});
