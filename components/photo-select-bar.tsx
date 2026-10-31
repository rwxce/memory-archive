'use client';

import { forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import type { AssignOutcome } from '@/hooks/use-photo-assign';
import { PillButton } from './pill-button';
import { SectionCard } from './section-card';

/** The sticky bar at the bottom while pictures are chosen: how many, "Assign to…" and "Clear". */
export function PhotoActionBar({ count, disabled, onAssign, onClear }: { count: number; disabled: boolean; onAssign: () => void; onClear: () => void }) {
  const t = useTranslations('photos.select');
  return (
    <div
      data-testid="select-bar"
      className="bg-sf2 shadow-soft sticky bottom-3 z-20 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-3xl p-3 ps-5 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <p className="font-medium tabular-nums">{t('count', { count })}</p>
      <div className="flex gap-2">
        <PillButton variant="outlined" onClick={onClear}>
          {t('clear')}
        </PillButton>
        <PillButton aria-disabled={disabled || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !disabled && onAssign()}>
          {t('assignButton')}
        </PillButton>
      </div>
    </div>
  );
}

/**
 * What happened to the last assignment, in words that stay on screen: how many were added and how many were
 * already there, with "Undo this assignment" (which takes back exactly the links this assignment added, all together or
 * not at all; if that fails the button stays so it can be tried again), or that it failed.
 * The screen moves focus here so it is read.
 */
export const PhotoAssignResult = forwardRef<HTMLDivElement, { outcome: AssignOutcome; busy: boolean; undoFailed?: boolean; onUndo: () => void; onClose: () => void }>(function PhotoAssignResult({ outcome, busy, undoFailed = false, onUndo, onClose }, ref) {
  const t = useTranslations('photos.select.result');
  const failed = outcome.kind === 'failed';
  return (
    <SectionCard tone="soft" className="gap-3 p-[18px]" aria-label={t('label')}>
      <div ref={ref} tabIndex={-1} role={failed ? 'alert' : undefined} data-testid="select-result" className="flex flex-col gap-1 outline-none">
        {outcome.kind === 'assigned' && (
          <>
            <p className="font-medium">{t('added', { count: outcome.added })}</p>
            {outcome.alreadyThere > 0 && <p className="text-t2 text-sm">{t('already', { count: outcome.alreadyThere })}</p>}
            {outcome.fresh && outcome.fresh.length > 0 && <p className="text-t2 text-sm">{t('undoNote')}</p>}
            {undoFailed && (
              <p role="alert" data-testid="undo-failed">
                {t('undoFailed')}
              </p>
            )}
          </>
        )}
        {outcome.kind === 'undone' && <p className="font-medium">{t('undone', { count: outcome.removed })}</p>}
        {failed && <p>{t(outcome.what === 'undo' ? 'undoFailed' : 'failed')}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {outcome.kind === 'assigned' && outcome.fresh && outcome.fresh.length > 0 && (
          <PillButton variant="outlined" aria-disabled={busy || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !busy && onUndo()}>
            {t('undo')}
          </PillButton>
        )}
        <PillButton variant="ghost-link" className="px-0" onClick={onClose}>
          {t('close')}
        </PillButton>
      </div>
    </SectionCard>
  );
});
