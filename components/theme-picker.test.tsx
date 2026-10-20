import { afterEach, describe, expect, test } from 'vitest';
import en from '@/messages/en.json';
import { THEME_STORAGE_KEY } from '@/hooks/theme';
import { click, render, type Rendered } from './test-utils';
import { ThemePicker } from './theme-picker';
import { ThemeSync } from './theme-sync';

describe('ThemePicker', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  const button = (label: string) =>
    [...(view?.container.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);

  test('starts on "same as this device" and stores an explicit choice', async () => {
    view = await render(<ThemePicker />);
    expect(button(en.settings.theme.system)?.getAttribute('aria-pressed')).toBe('true');

    await click(button(en.settings.theme.dark));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(button(en.settings.theme.dark)?.getAttribute('aria-pressed')).toBe('true');

    await click(button(en.settings.theme.system));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  test('reads a stored choice', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    view = await render(<ThemePicker />);
    expect(button(en.settings.theme.light)?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ThemeSync', () => {
  test('re-applies the stored theme when a new document shell mounts', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    document.documentElement.className = '';
    const view = await render(<ThemeSync />);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    view.unmount();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });
});
