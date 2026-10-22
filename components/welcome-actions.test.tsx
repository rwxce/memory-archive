import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { click, render, type Rendered } from './test-utils';
import { WelcomeActions } from './welcome-actions';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

describe('WelcomeActions', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    vi.unstubAllGlobals();
    push.mockClear();
  });

  test('offers Start and Open an archive as real buttons', async () => {
    view = await render(<WelcomeActions />);
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual([en.welcome.start, en.welcome.open]);
  });

  test('Start asks the browser for persistent storage, then goes to People', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist, persisted: async () => false } });
    view = await render(<WelcomeActions />);
    expect(push).not.toHaveBeenCalled();
    await click(view.container.querySelector('button'));
    expect(persist).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('/people');
  });

  test('Open an archive explains politely that it is not ready yet', async () => {
    view = await render(<WelcomeActions />);
    const status = view.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
    await click(view.container.querySelectorAll('button')[1]);
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe(en.welcome.comingSoon);
    expect(push).not.toHaveBeenCalled();
  });
});
