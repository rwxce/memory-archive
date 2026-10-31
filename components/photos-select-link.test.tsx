import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { useLibrary } from '@/hooks/use-library';
import { PhotosSelectLink } from './photos-select-link';

// The Photos screen opens the library; the card under test only reads from it.
function Opened({ version }: { version: unknown }) {
  const { state } = useLibrary();
  return state.status === 'ready' ? <PhotosSelectLink version={version} /> : null;
}

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const item = (n: number) => ({
  sha256: hash(n), kind: 'photo' as const, mime: 'image/jpeg', takenAt: '2026-03-13T10:00:00Z', takenOffsetMinutes: null, dateSource: 'sidecar' as const,
  latitude: null, longitude: null, description: '', album: '', fileName: `${n}.jpg`,
});

describe('PhotosSelectLink', () => {
  test('is absent while the collection is empty; otherwise it says how many pictures nobody has yet and links to the grid', async () => {
    const lib = await createTestLibrary();
    view = await renderWithLibrary(<Opened version={0} />, { lib });
    await settle();
    expect(view.container.textContent).toBe('');
    await lib.client.call('importPhotoItems', {
      batchId: '00000000-0000-4000-8000-000000000501', source: 'takeout', sourceLabel: 'a.zip', now: '2026-03-01T10:00:00Z',
      blobs: [1, 2].map((n) => ({ sha256: hash(n), size: 1, mime: null })), items: [item(1), item(2)],
    });
    view.unmount();
    view = await renderWithLibrary(<Opened version={1} />, { lib });
    await settle();
    expect(view.container.textContent).toContain(en.photos.selectLink.title);
    expect(view.container.textContent).toContain('2 pictures are not assigned to anyone yet.');
    expect(view.container.querySelector('a')!.getAttribute('href')).toBe('/photos/select');
  });
});
