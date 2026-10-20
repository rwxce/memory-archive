import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { click, render, type Rendered } from './test-utils';
import { WelcomeActions } from './welcome-actions';

describe('WelcomeActions', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    vi.unstubAllGlobals();
  });

  test('offers Start and Open an archive as real buttons', async () => {
    view = await render(<WelcomeActions />);
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual([en.welcome.start, en.welcome.open]);
  });

  test('Start asks the browser for persistent storage, then explains itself politely', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist, persisted: async () => false } });
    view = await render(<WelcomeActions />);
    const status = view.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
    await click(view.container.querySelector('button'));
    expect(persist).toHaveBeenCalledOnce();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe(en.welcome.comingSoon);
  });
});
