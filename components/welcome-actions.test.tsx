import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { createTestLibrary, libraryOf } from '@/lib/usecases/test-client';
import { click, renderWithLibrary } from './test-utils';
import { WelcomeActions } from './welcome-actions';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

describe('WelcomeActions', () => {
  let view: Awaited<ReturnType<typeof renderWithLibrary>> | undefined;
  afterEach(() => {
    view?.unmount();
    vi.unstubAllGlobals();
    push.mockClear();
  });

  test('offers Start and Open an archive as real buttons', async () => {
    view = await renderWithLibrary(<WelcomeActions />);
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual([en.welcome.start, en.welcome.open]);
  });

  test('Start asks the browser for persistent storage, then goes to People', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist, persisted: async () => false } });
    view = await renderWithLibrary(<WelcomeActions />);
    expect(push).not.toHaveBeenCalled();
    await click(view.container.querySelector('button'));
    expect(persist).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/people');
  });

  test('Open an archive takes a ZIP only, and says calmly when a file is not an archive', async () => {
    const lib = await createTestLibrary();
    const open = vi.fn();
    view = await renderWithLibrary(<WelcomeActions />, { open: async () => (open(), libraryOf(lib.deps)) });
    expect(open).not.toHaveBeenCalled(); // nothing opens until a file is picked
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain('.zip');
    const file = new File(['not a zip'], 'x.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(open).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(view!.container.querySelector('[role="alert"]')?.textContent).toBe(en.archive.error.invalid));
    expect(push).not.toHaveBeenCalled();
  });
});
