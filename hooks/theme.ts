/**
 * Light / dark theme: follows the device (`prefers-color-scheme`) unless the
 * person picked one in Settings. The choice is stored on this device only.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'memory-archive:theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Whether the page should render dark for a choice and the device preference. */
export function resolveDark(choice: ThemeChoice, prefersDark: boolean): boolean {
  return choice === 'dark' || (choice === 'system' && prefersDark);
}

export function readThemeChoice(storage: Pick<Storage, 'getItem'> | undefined): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Classic inline script for <head>: applies the theme before first paint (no
 * flash) and keeps following the device while the choice is `system`. Mirrors
 * `readThemeChoice` + `resolveDark`; `theme.test.ts` runs it.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var m=window.matchMedia('(prefers-color-scheme: dark)');var a=function(){var c=null;try{c=localStorage.getItem(k)}catch(e){}if(c!=='light'&&c!=='dark')c='system';document.documentElement.classList.toggle('dark',c==='dark'||(c==='system'&&m.matches));};a();m.addEventListener('change',a);window.addEventListener('storage',function(e){if(e.key===k)a();});window.__memoryArchiveApplyTheme=a;}catch(e){}})();`;
