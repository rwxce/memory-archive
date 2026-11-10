import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import ca from '@/messages/ca.json';
import type { NewPhotoItem } from '@/lib/domain/photo';
import { assignPhotos } from '@/lib/usecases/photo-assign';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { useLibrary } from '@/hooks/use-library';
import { PersonBento } from './person-overview';
import { PersonSections } from './person-sections';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sub',
}));

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

async function seed(count: number) {
  const lib = await createTestLibrary();
  const ana = await createProfile(lib.deps, { displayName: 'Ana' });
  if (count > 0) {
    const numbers = Array.from({ length: count }, (_, i) => i + 1);
    await lib.client.call('importPhotoItems', {
      batchId: '00000000-0000-4000-8000-000000000501',
      source: 'takeout',
      sourceLabel: 'trip.zip',
      now: '2026-03-01T10:00:00Z',
      blobs: numbers.map((n) => ({ sha256: hash(n), size: 1, mime: null })),
      items: numbers.map(item),
    });
    await assignPhotos(lib.deps, { sha256s: numbers.map(hash), profileIds: [ana.id] });
  }
  return { lib, ana };
}

/** The person's page opens the library; here the probe does. */
function Page({ id }: { id: string }) {
  useLibrary();
  return <PersonBento personId={id} overview={undefined} />;
}

describe('the Photos card of the person’s page', () => {
  let view: Rendered | undefined;
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
  });
  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.unstubAllGlobals();
  });

  const card = (id: string) => view!.container.querySelector<HTMLAnchorElement>(`a[href="/person/photos?id=${id}"]`);

  test('links to the person’s photos with the count and at most four previews', async () => {
    const { lib, ana } = await seed(6);
    view = await renderWithLibrary(<Page id={ana.id} />, { lib });
    await settle();
    const link = card(ana.id)!;
    expect(link.textContent).toContain('Photos');
    expect(link.textContent).toContain('6 pictures assigned');
    expect(link.querySelectorAll('[aria-hidden].aspect-square')).toHaveLength(4);
  });

  test('with nothing assigned it is a quiet card that says so and still leads to the page', async () => {
    const { lib, ana } = await seed(0);
    view = await renderWithLibrary(<Page id={ana.id} />, { lib });
    await settle();
    expect(card(ana.id)!.textContent).toContain(en.person.photos.none);
    expect(card(ana.id)!.querySelector('.aspect-square')).toBeNull();
  });

  test('is worded in Catalan', async () => {
    const { lib, ana } = await seed(1);
    view = await renderWithLibrary(<Page id={ana.id} />, { lib, messages: ca });
    await settle();
    expect(card(ana.id)!.textContent).toContain('1 foto assignada');
  });

  test('the pill list offers Photos and marks it when current', async () => {
    const { lib, ana } = await seed(0);
    view = await renderWithLibrary(<PersonSections personId={ana.id} current="photos" />, { lib });
    const link = card(ana.id)!;
    expect(link.textContent).toBe('Photos');
    expect(link.getAttribute('aria-current')).toBe('page');
  });
});
