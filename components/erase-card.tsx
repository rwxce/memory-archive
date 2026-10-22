'use client';

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useEraseDevice } from '@/hooks/use-erase-device';
import { useRouter } from '@/i18n/navigation';

type Phase = 'idle' | 'confirming' | 'erasing' | 'failed';

/**
 * Settings: erase everything this app keeps on the device. A native modal `<dialog>` asks first
 * (focus is trapped and returned by the browser, Escape cancels) and recommends a backup. While
 * erasing it cannot be dismissed. On success the person goes back to the welcome screen; if
 * something could not be erased, the dialog says so and offers to try again.
 */
export function EraseCard() {
  const t = useTranslations('settings.erase');
  const erase = useEraseDevice();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const open = phase !== 'idle';

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const run = async () => {
    setPhase('erasing');
    const result = await erase();
    if (result.complete) router.replace('/welcome');
    else setPhase('failed');
  };
  const cancel = () => {
    if (phase !== 'erasing') setPhase('idle');
  };
  const erasing = phase === 'erasing';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setPhase('confirming')}>
          <Trash2 aria-hidden />
          {t('button')}
        </Button>
      </CardContent>

      <dialog
        ref={dialog}
        aria-labelledby="erase-title"
        aria-describedby="erase-body"
        onCancel={(event) => {
          event.preventDefault();
          cancel();
        }}
        className="bg-background text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border p-6 shadow-lg backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <h2 id="erase-title" className="font-serif text-xl">
            {t('dialogTitle')}
          </h2>
          <div id="erase-body" className="flex flex-col gap-2 text-sm">
            <p>{t('dialogBody')}</p>
            <p className="font-medium">{t('backupAdvice')}</p>
          </div>
          <p role={phase === 'failed' ? 'alert' : 'status'} className="text-destructive min-h-5 text-sm">
            {phase === 'failed' ? t('failed') : erasing ? <span className="text-muted-foreground">{t('erasing')}</span> : null}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={cancel} disabled={erasing} autoFocus>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={run} disabled={erasing}>
              {phase === 'failed' ? t('retry') : t('confirm')}
            </Button>
          </div>
        </div>
      </dialog>
    </Card>
  );
}
