'use client';

import { useCallback, useEffect, useState } from 'react';
import { readThemeChoice, resolveDark, THEME_STORAGE_KEY, type ThemeChoice } from './theme';

declare global {
  interface Window {
    /** Installed by THEME_INIT_SCRIPT: re-applies the stored choice. */
    __memoryArchiveApplyTheme?: () => void;
  }
}

function applyNow(choice: ThemeChoice) {
  if (window.__memoryArchiveApplyTheme) {
    window.__memoryArchiveApplyTheme();
    return;
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.documentElement.classList.toggle('dark', resolveDark(choice, prefersDark));
}

/** Apply the choice stored on this device (or the device preference) now. */
export function reapplyStoredTheme(): void {
  applyNow(readThemeChoice(window.localStorage));
}

/** Current theme choice and a setter that stores it on this device. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  // `system` on the server and the first client render, then the stored value.
  const [choice, setChoiceState] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoiceState(readThemeChoice(window.localStorage));
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
    setChoiceState(next);
    applyNow(next);
  }, []);

  return [choice, setChoice];
}
