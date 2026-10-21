'use client';

import { LibraryNotice } from '@/components/library-notice';
import { useLibraryState } from '@/hooks/use-library';

/**
 * The reason the library could not be opened, for pages that show something else
 * (the welcome): nothing while it is loading or fine. It never asks the library to open.
 */
export function LibraryProblem() {
  const { state, retry } = useLibraryState();
  if (state.status !== 'unavailable' && state.status !== 'error') return null;
  return <LibraryNotice state={state} onRetry={retry} />;
}
