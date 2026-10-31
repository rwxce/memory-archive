'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { LoadingNote } from '@/components/screen-states';
import { SectionCard } from '@/components/section-card';
import type { PhotoBatches } from '@/hooks/use-photo-batches';
import type { PhotoBatch } from '@/lib/domain/photo';
import { NAME_IN_ROW, nameTag, safeName } from '@/components/safe-name';

const KNOWN = ['takeout', 'google-photos-zip', 'loose'] as const;

/**
 * Earlier imports that added photos, newest first, each with Undo. Undo asks first, naming the import and how many items
 * it will remove, and says what stays. Names are shown as text only and clamped.
 */
export function PhotosBatchesCard({ batches, disabled }: { batches: PhotoBatches; disabled: boolean }) {
  const t = useTranslations('photos.batches');
  const { state, undo } = batches;
  const [asking, setAsking] = useState<string | null>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const outcome = undo.status === 'done' || undo.status === 'failed' ? undo : undefined;

  // The row that asked is gone after an undo: put focus on what happened, so it is read and the keyboard stays in place.
  useEffect(() => {
    if (outcome) note.current?.focus();
  }, [outcome]);

  return (
    <SectionCard className="gap-3 p-[18px]" aria-labelledby="photos-batches-title">
      <Eyebrow as="h2" id="photos-batches-title" tone="muted" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      {undo.status === 'working' && <LoadingNote>{t('working')}</LoadingNote>}
      {outcome && (
        <p ref={note} tabIndex={-1} role={outcome.status === 'failed' ? 'alert' : 'status'} data-testid="photos-undo-result" className="bg-bg rounded-[14px] p-3.5 outline-none">
          {outcome.status === 'failed' ? t('undoFailed') : outcome.removedItems > 0 ? t('undone', { count: outcome.removedItems }) : t('undoneNone')}
          {outcome.status === 'done' && outcome.removedAssignments > 0 && <> {t('undoneAssignments', { count: outcome.removedAssignments })}</>}
        </p>
      )}
      {state.status === 'loading' && <LoadingNote>{t('loading')}</LoadingNote>}
      {state.status === 'error' && <p role="alert">{t('failed')}</p>}
      {state.status === 'ready' && state.batches.length === 0 && <p className="text-t2">{t('empty')}</p>}
      {state.status === 'ready' && state.batches.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="photos-batches">
          {state.batches.map((batch) => (
            <BatchRow
              key={batch.id}
              batch={batch}
              asking={asking === batch.id}
              disabled={disabled || undo.status === 'working'}
              onAsk={() => {
                batches.clearOutcome();
                setAsking(batch.id);
              }}
              onKeep={() => setAsking(null)}
              onUndo={() => {
                setAsking(null);
                void batches.undoBatch(batch.id);
              }}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function BatchRow({ batch, asking, disabled, onAsk, onKeep, onUndo }: { batch: PhotoBatch; asking: boolean; disabled: boolean; onAsk: () => void; onKeep: () => void; onUndo: () => void }) {
  const t = useTranslations('photos.batches');
  const format = useFormatter();
  const undoButton = useRef<HTMLButtonElement>(null);
  const keptFocus = useRef(false);
  const source = t(`source.${(KNOWN as readonly string[]).includes(batch.source) ? batch.source : 'other'}`);
  const label = safeName(batch.sourceLabel, NAME_IN_ROW);
  const name = label === '' ? source : label;

  // "Keep" closes the question: the keyboard goes back to the button that opened it, not to the top of the page.
  useEffect(() => {
    if (!asking && keptFocus.current) {
      keptFocus.current = false;
      undoButton.current?.focus();
    }
  }, [asking]);
  return (
    <li className="bg-bg flex flex-col gap-2 rounded-[14px] p-3.5" data-testid="photos-batch">
      <div className="flex flex-col gap-0.5">
        <span className="line-clamp-2 font-medium break-words" data-testid="photos-batch-name">
          <bdi>{name}</bdi>
        </span>
        <span className="text-t2 text-sm">
          {source} · {format.dateTime(new Date(batch.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
        <span className="text-t2 text-sm">{t('added', { count: batch.addedCount })}</span>
      </div>
      {asking ? (
        <div role="group" aria-labelledby={`undo-${batch.id}`} className="flex flex-col gap-2">
          <p id={`undo-${batch.id}`} className="font-medium break-words">
            {t.rich('confirmTitle', { name: nameTag(name) })}
          </p>
          <p className="text-t2 text-sm leading-relaxed">{t('confirmBody', { count: batch.addedCount })}</p>
          <p className="text-t2 text-sm leading-relaxed">{t('confirmAssignments')}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <PillButton
              variant="outlined"
              autoFocus
              onClick={() => {
                keptFocus.current = true;
                onKeep();
              }}
            >
              {t('confirmKeep')}
            </PillButton>
            <PillButton variant="danger" aria-disabled={disabled || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !disabled && onUndo()}>
              {t('confirmYes')}
            </PillButton>
          </div>
        </div>
      ) : (
        <div>
          <PillButton ref={undoButton} variant="outlined" aria-label={t('undoLabel', { name: safeName(name) })} aria-disabled={disabled || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !disabled && onAsk()}>
            {t('undo')}
          </PillButton>
        </div>
      )}
    </li>
  );
}
