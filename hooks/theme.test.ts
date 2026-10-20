import { afterEach, describe, expect, test } from 'vitest';
import { readThemeChoice, resolveDark, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from './theme';

function runInitScript() {
  // The script is a classic inline <script>: evaluate it as the browser would.
  new Function(THEME_INIT_SCRIPT)();
}

describe('theme', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  test('resolveDark', () => {
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('light', true)).toBe(false);
    expect(resolveDark('system', true)).toBe(true);
    expect(resolveDark('system', false)).toBe(false);
  });

  test('readThemeChoice ignores unknown or unreadable values', () => {
    expect(readThemeChoice({ getItem: () => 'dark' })).toBe('dark');
    expect(readThemeChoice({ getItem: () => 'purple' })).toBe('system');
    expect(
      readThemeChoice({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
    expect(readThemeChoice(undefined)).toBe('system');
  });

  test('the inline script applies the stored choice before React runs', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runInitScript();
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    window.__memoryArchiveApplyTheme?.();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
