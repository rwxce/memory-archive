import { afterEach, describe, expect, test } from 'vitest';
import en from '@/messages/en.json';
import { click, render, type Rendered } from './test-utils';
import { WelcomeActions } from './welcome-actions';

describe('WelcomeActions', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('offers Start and Open an archive as real buttons', async () => {
    view = await render(<WelcomeActions />);
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual([en.welcome.start, en.welcome.open]);
  });

  test('a placeholder action explains itself in a polite live region', async () => {
    view = await render(<WelcomeActions />);
    const status = view.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
    await click(view.container.querySelector('button'));
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe(en.welcome.comingSoon);
  });
});
