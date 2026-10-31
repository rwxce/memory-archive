import { shouldDeliverProgress } from './use-archive-checks';

/** Where a pack export or merge is: the archive's own steps, plus the password step (`encrypting` before a pack is saved, `decrypting` before one is opened). */
export type PackProgress =
  | { phase: 'preparing' | 'finishing' }
  | { phase: 'media' | 'encrypting' | 'decrypting'; done: number; total: number };

const fractionOf = (p: PackProgress): number | undefined => ('total' in p && p.total > 0 ? p.done / p.total : undefined);

/**
 * Wraps a progress callback so a walk over thousands of files does not re-render the screen for each one: a new phase
 * always gets through, the rest follows `shouldDeliverProgress` (every 100 ms, or a whole percent more).
 */
export function throttleProgress(deliver: (progress: PackProgress) => void): (progress: PackProgress) => void {
  let last: { at: number; percent: number; phase: PackProgress['phase'] } | undefined;
  return (progress) => {
    const fraction = fractionOf(progress);
    const now = Date.now();
    const newPhase = last?.phase !== progress.phase;
    if (!newPhase && !shouldDeliverProgress(last, fraction, now)) return;
    last = { at: now, percent: fraction === undefined ? -1 : Math.floor(fraction * 100), phase: progress.phase };
    deliver(progress);
  };
}
