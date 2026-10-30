import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import en from '@/messages/en.json';
import { createProfile } from '@/lib/usecases/profiles';
import { setProfilePhoto } from '@/lib/usecases/profile-photo';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { click, renderWithLibrary, settle, submit, type, type Rendered } from './test-utils';
import { PeopleScreen } from './people-screen';
import { PersonScreen } from './person-screen';

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/sub',
}));

// happy-dom cannot decode pictures: the downscale step is replaced by one that returns a tiny webp.
let decodes = true;
vi.mock('@/lib/storage/thumbnail', () => ({
  makeThumbnail: async (image: Blob) => {
    if (!decodes) return undefined;
    const marker = new Uint8Array(await image.arrayBuffer())[0] ?? 0;
    return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, marker])], { type: 'image/webp' });
  },
}));

const p = en.people;
const picture = (marker: number) => new File([new Uint8Array([marker, 1, 2, 3])], 'me.png', { type: 'image/png' });

async function choose(view: Rendered, file: File) {
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const buttonByText = (view: Rendered, text: string) =>
  [...view.container.querySelectorAll('button')].find((b) => (b.textContent?.trim() || b.getAttribute('aria-label')) === text) ?? null;
const imgs = (view: Rendered) => [...view.container.querySelectorAll('img')];

describe('profile photo UI', () => {
  let view: (Rendered & Awaited<ReturnType<typeof renderWithLibrary>>) | undefined;
  const created: string[] = [];
  const revoked: string[] = [];
  beforeEach(() => {
    decodes = true;
    search = '';
    let n = 0;
    URL.createObjectURL = () => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
  });
  afterEach(() => {
    view?.unmount();
    created.length = 0;
    revoked.length = 0;
  });

  test('the picker is a 44 px+ button that opens the device gallery or camera (image/* only)', async () => {
    const lib = await createTestLibrary();
    await createProfile(lib.deps, { displayName: 'Ana' });
    view = await renderWithLibrary(<PeopleScreen />, { lib });
    await settle();
    await click(buttonByText(view, p.add));
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/*');
    expect(input.getAttribute('aria-hidden')).toBe('true');
    expect(buttonByText(view, p.form.photoChoose)!.className).toContain('h-11');
    expect(buttonByText(view, p.form.photoRemove)).toBeNull();
  });

  test('creating a person with a photo previews it, stores it and shows it in the list', async () => {
    const lib = await createTestLibrary();
    await createProfile(lib.deps, { displayName: 'Ana' });
    view = await renderWithLibrary(<PeopleScreen />, { lib });
    await settle();
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Carla');
    await choose(view, picture(7));
    expect(imgs(view)).toHaveLength(1);
    expect(buttonByText(view, p.form.photoChange)).not.toBeNull();
    await submit(form);
    await settle();

    const stored = (await lib.client.call('listProfiles')).find((x) => x.displayName === 'Carla')!;
    expect(stored.photoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Carla was added.');
    // Carla has a photo; Ana still shows her initial.
    expect(imgs(view)).toHaveLength(1);
    const cards = [...view.container.querySelectorAll('li')];
    expect(cards.find((li) => li.textContent?.includes('Carla'))!.querySelector('img')).not.toBeNull();
    expect(cards.find((li) => li.textContent?.includes('Ana'))!.querySelector('img')).toBeNull();
    // The preview URL was revoked when the form went away.
    expect(revoked.length).toBeGreaterThan(0);
  });

  test('a file that is not a picture is explained and not kept', async () => {
    view = await renderWithLibrary(<PeopleScreen />);
    await settle();
    await click(buttonByText(view, p.add));
    await choose(view, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(view.container.textContent).toContain(p.form.photoInvalid);
    expect(imgs(view)).toHaveLength(0);
  });

  test('if only the photo fails, the person is still saved and the message says so', async () => {
    decodes = false;
    const lib = await createTestLibrary();
    await createProfile(lib.deps, { displayName: 'Ana' });
    view = await renderWithLibrary(<PeopleScreen />, { lib });
    await settle();
    await click(buttonByText(view, p.add));
    const form = view.container.querySelector('form')!;
    await type(form.querySelector('input'), 'Carla');
    await choose(view, picture(7));
    await submit(form);
    await settle();
    const stored = (await lib.client.call('listProfiles')).find((x) => x.displayName === 'Carla')!;
    expect(stored.photoSha256).toBeNull();
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Carla was added, but the photo could not be saved. You can add it by editing the person.');
  });

  test('the person screen shows the stored photo, and editing can replace or remove it', async () => {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    await setProfilePhoto(lib.deps, ana.id, picture(1));
    search = `id=${ana.id}`;
    view = await renderWithLibrary(<PersonScreen />, { lib });
    await settle();
    expect(imgs(view)).toHaveLength(1);

    await click(view.container.querySelector('button[aria-haspopup="menu"]'));
    await click([...view.container.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === 'Edit Ana'));
    await settle();
    expect(imgs(view)).toHaveLength(1);
    await click(buttonByText(view, p.form.photoRemove));
    expect(imgs(view)).toHaveLength(0);
    await submit(view.container.querySelector('form'));
    await settle();
    expect((await lib.client.call('getProfile', { id: ana.id })).photoSha256).toBeNull();
    expect(imgs(view)).toHaveLength(0);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Changes to Ana were saved.');
  });
});
