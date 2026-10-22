import { afterEach, describe, expect, test } from 'vitest';
import en from '@/messages/en.json';
import { GitHubLink, REPOSITORY_URL } from './github-link';
import { render, type Rendered } from './test-utils';

describe('GitHubLink', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('links to the repository in a new tab without leaking the opener', async () => {
    view = await render(<GitHubLink />);
    const link = view.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(REPOSITORY_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe(en.nav.sourceCode);
    expect(link?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
