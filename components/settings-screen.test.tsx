import { afterEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { renderWithLibrary, settle, type Rendered } from './test-utils';
import { SettingsScreen } from './settings-screen';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/settings',
}));

const s = en.settings;
let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const rowFor = (title: string) => [...document.querySelectorAll('a')].find((a) => a.textContent?.includes(title));

describe('SettingsScreen', () => {
  test('groups the rows under headings and links every section of the PRD list', async () => {
    view = await renderWithLibrary(<SettingsScreen />);
    await settle();
    const headings = [...document.querySelectorAll('h1, h2')].map((h) => h.textContent);
    expect(headings[0]).toBe(s.title);
    expect(headings).toContain(s.groups.archive);
    expect(headings).toContain(s.groups.copies);
    expect(document.querySelector('[aria-labelledby="group-copies"]')?.querySelectorAll('a')).toHaveLength(4);
    expect(rowFor(s.history.title)?.getAttribute('href')).toBe('/import/history');
    expect(rowFor(s.sync.title)?.getAttribute('href')).toBe('/sync');
  });

  test('data portability opens the export card and security explains the backup password', async () => {
    view = await renderWithLibrary(<SettingsScreen />);
    await settle();
    expect(rowFor(s.portability.title)?.getAttribute('href')).toBe('/backup#viewer-export');
    const security = rowFor(s.security.title);
    expect(security?.getAttribute('href')).toBe('/backup');
    expect(security?.textContent).toContain('never saved');
  });

  test('shows the app and archive format versions', async () => {
    view = await renderWithLibrary(<SettingsScreen />);
    await settle();
    expect(document.querySelector('[data-testid="app-version"]')?.textContent).toMatch(/App version/);
    expect(document.querySelector('[data-testid="format-version"]')?.textContent).toMatch(/Archive file format/);
  });
});
