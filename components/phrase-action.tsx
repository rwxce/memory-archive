'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Quote } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { Button } from '@/components/ui/button';
import { phraseFromBody, useSetPhrase, type PhraseTarget } from '@/hooks/use-phrase';

/** Whether a message can be a phrase: it has text to show (a photo or voice note with no caption does not). */
export const canBePhrase = (body: string | null | undefined): body is string => !!body && phraseFromBody(body) !== '';

/**
 * Asks before a person's phrase is replaced, in a native modal `<dialog>` (focus is trapped and
 * returned to the button that opened it, Escape cancels). The current phrase is untrusted text.
 */
function ReplaceDialog({ target, busy, failed, onCancel, onConfirm }: { target: PhraseTarget; busy: boolean; failed: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useTranslations('phrase');
  const dialog = useRef<HTMLDialogElement>(null);
  const uid = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${uid}-title`}
      aria-describedby={`${uid}-body`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="bg-bg text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl p-6 shadow-soft backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id={`${uid}-title`} className="font-display text-headline" dir="auto">
          {t('title', { name: target.name })}
        </h2>
        <div id={`${uid}-body`} className="flex flex-col gap-2 text-sm">
          <p>{t('body', { name: target.name })}</p>
          <p className="text-mu text-xs">{t('current')}</p>
          <p dir="auto" className="bg-sf max-h-40 overflow-y-auto rounded-2xl px-3.5 py-2.5 break-words whitespace-pre-line">
            {target.phrase}
          </p>
        </div>
        <p role={failed ? 'alert' : 'status'} className="text-destructive min-h-5 text-sm">
          {failed ? t('failed', { name: target.name }) : busy ? <span className="text-muted-foreground">{t('saving')}</span> : null}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <PillButton variant="outlined" onClick={onCancel} disabled={busy} autoFocus>
            {t('cancel')}
          </PillButton>
          <PillButton onClick={onConfirm} disabled={busy}>
            {t('confirm')}
          </PillButton>
        </div>
      </div>
    </dialog>
  );
}

/**
 * "Use as {name}'s phrase" for a message with text. Asks first when the person already has a phrase;
 * says calmly whether it was saved. Renders nothing for a message without text.
 */
export function PhraseAction({ body, target }: { body: string | null | undefined; target: PhraseTarget }) {
  const t = useTranslations('phrase');
  const setPhrase = useSetPhrase();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'saved' | 'failed' | null>(null);
  if (!canBePhrase(body)) return null;

  const run = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await setPhrase(target.id, body);
      setOutcome('saved');
      setAsking(false);
    } catch {
      setOutcome('failed');
    } finally {
      setBusy(false);
    }
  };
  const press = () => {
    setOutcome(null);
    if (target.phrase.trim() === '') void run();
    else setAsking(true);
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={press} disabled={busy} className="min-h-11 w-fit max-w-full rounded-full whitespace-normal">
        <Quote aria-hidden />
        <span dir="auto" className="min-w-0 break-words">
          {t('action', { name: target.name })}
        </span>
      </Button>
      <p role="status" className="text-mu min-h-0 text-xs break-words">
        {outcome === 'saved' ? t('saved', { name: target.name }) : ''}
      </p>
      {outcome === 'failed' && !asking && (
        <p role="alert" className="text-destructive text-xs break-words">
          {t('failed', { name: target.name })}
        </p>
      )}
      {asking && (
        <ReplaceDialog
          target={target}
          busy={busy}
          failed={outcome === 'failed'}
          onCancel={() => {
            setAsking(false);
            setOutcome(null);
          }}
          onConfirm={() => void run()}
        />
      )}
    </>
  );
}
