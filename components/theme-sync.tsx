'use client';

import { useEffect } from 'react';
import { reapplyStoredTheme } from '@/hooks/use-theme';

/**
 * Switching language swaps the whole document shell (`<html lang>`) on the
 * client, which drops the `dark` class the inline head script set on first
 * load (that script does not run again on client navigation). Re-apply it
 * whenever a locale layout mounts.
 */
export function ThemeSync() {
  useEffect(() => {
    reapplyStoredTheme();
  }, []);
  return null;
}
