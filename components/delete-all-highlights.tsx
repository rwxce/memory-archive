'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';

/**
 * "Delete all" for a person's highlights: a danger button that asks first in a native modal `<dialog>`
 * (focus is trapped and goes back to the button on cancel, Escape cancels). `onConfirm` returns whether
 * it worked; on failure the dialog stays open and says nothing was changed. After a success the
 * parent removes this button, so it also decides where focus goes.
 */
export function DeleteAllHighlights({ name, count, onConfirm }: { name: string; count: number; onConfirm: () => Promise<boolean> }) {
  const t = useTranslations('personHighlights');
  const [asking, setAsking] = useState(false);
  return (
    <>
      <PillButton variant="danger" onClick={() => setAsking(true)} className="self-start">
        {t('deleteAll')}
      </PillButton>
      {asking && (
        <AllDialog
          name={name}
          count={count}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            const done = await onConfirm();
            if (done) setAsking(false);
            return done;
          }}
        />
      )}
    </>
  );
}

function AllDialog({ name, count, onCancel, onConfirm }: { name: string; count: number; onCancel: () => void; onConfirm: () => Promise<boolean> }) {
  const t = useTranslations('personHighlights');
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<'asking' | 'deleting' | 'failed'>('asking');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const run = async () => {
    setPhase('deleting');
    if (!(await onConfirm())) setPhase('failed');
  };
  const deleting = phase === 'deleting';

  return (
    <dialog
      ref={dialog}
      aria-labelledby="highlights-delete-all-title"
      aria-describedby="highlights-delete-all-body"
      onCancel={(event) => {
        event.preventDefault();
        if (!deleting) onCancel();
      }}
      className="bg-bg text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl p-6 shadow-soft backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id="highlights-delete-all-title" className="font-display text-headline break-words" dir="auto">
          {t('deleteAllTitle', { name })}
        </h2>
        <p id="highlights-delete-all-body" className="text-sm break-words">
          {t('deleteAllBody', { count, name })}
        </p>
        <p role={phase === 'failed' ? 'alert' : 'status'} className="text-destructive min-h-5 text-sm">
          {phase === 'failed' ? t('deleteAllFailed') : deleting ? <span className="text-muted-foreground">{t('deleting')}</span> : null}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <PillButton variant="outlined" onClick={onCancel} disabled={deleting} autoFocus>
            {t('cancel')}
          </PillButton>
          <PillButton variant="danger" onClick={run} disabled={deleting}>
            {t('deleteAllConfirm')}
          </PillButton>
        </div>
      </div>
    </dialog>
  );
}
