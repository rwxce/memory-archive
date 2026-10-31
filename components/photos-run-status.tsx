'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Outcome } from '@/components/backup-check-cards';
import { PillButton } from '@/components/pill-button';
import { PackProgressBar } from '@/components/sync-progress';
import type { PhotoFailure, PhotoImport, PhotoRunResult } from '@/hooks/use-photo-import';
import { Link } from '@/i18n/navigation';
import { LoadingNote } from '@/components/screen-states';
import { nameTag } from '@/components/safe-name';

const linkClass =
  'text-ac-tx focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]';
/** Nothing changed for these; for the others the outcome may be unknown or the cause is not the file, so the title does not claim it. */
const TITLE: Record<PhotoFailure, 'title' | 'titleUnsure' | 'titleWrong'> = {
  invalid: 'title',
  unreadable: 'title',
  limit: 'title',
  busy: 'title',
  newer: 'title',
  closed: 'titleUnsure',
  storage: 'titleWrong',
  generic: 'titleWrong',
};
const WHERE = { chat: '/import', backup: '/backup', sync: '/sync' } as const;

/** What the running or finished import says: progress with Stop, the counts, a calm pointer, or a calm error. Nothing here is raw error text. */
export function PhotosRunStatus({ run }: { run: PhotoImport }) {
  const t = useTranslations('photos');
  const { state } = run;
  const section = useRef<HTMLElement>(null);
  const resulted = state.status === 'done' || state.status === 'stopped' || state.status === 'elsewhere' || state.status === 'failed';

  // A result is the answer to what the person just did: move focus to it so it is read and the keyboard continues from there
  // (the button that started the import may be gone or elsewhere on the page).
  useEffect(() => {
    if (resulted) section.current?.querySelector<HTMLElement>('[data-testid="photos-result"]')?.focus();
  }, [state, resulted]);

  if (state.status === 'idle' && !run.refused) return null;
  return (
    <section ref={section} aria-label={t('progressLabel')} className="flex flex-col gap-3" data-testid="photos-status">
      {run.refused && (
        <p role="status" className="text-t2 break-words" data-testid="photos-refused">
          {t('busyNow')}
        </p>
      )}
      {state.status === 'checking' && <LoadingNote>{t.rich('checking', { name: nameTag(state.fileName) })}</LoadingNote>}
      {state.status === 'working' && (
        <div className="bg-sf flex flex-col gap-3 rounded-3xl p-[18px]">
          <PackProgressBar label={t('progressLabel')} progress={state.progress} />
          <div>
            <PillButton variant="outlined" aria-disabled={!state.cancellable || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => state.cancellable && run.cancel()}>
              {t('stop')}
            </PillButton>
          </div>
        </div>
      )}
      {state.status === 'stopped' && (
        <Outcome icon="quiet" role="status" testId="photos-result">
          <p>{t('stopped')}</p>
        </Outcome>
      )}
      {state.status === 'elsewhere' && (
        <Outcome icon="quiet" role="status" testId="photos-result">
          <p className="break-words">{t.rich(`elsewhere.${state.where}`, { name: nameTag(state.fileName) })}</p>
          <Link href={WHERE[state.where]} className={linkClass}>
            {t(`elsewhere.${state.where}Link`)}
          </Link>
        </Outcome>
      )}
      {state.status === 'failed' && (
        <Outcome icon="attention" title={t(`error.${TITLE[state.code]}`)} testId="photos-result">
          <p role="alert" className="break-words">
            {t(`error.${state.code}`)}
          </p>
        </Outcome>
      )}
      {state.status === 'done' && <PhotosResult result={state.result} onAnother={run.reset} />}
    </section>
  );
}

/** What was added and what was not, in plain words. A line with nothing to say is left out. */
function PhotosResult({ result, onAnother }: { result: PhotoRunResult; onAnother: () => void }) {
  const t = useTranslations('photos.result');
  const s = result.summary;
  const lines: [string, number][] = [
    ['added', s.added],
    ['alreadyThere', s.alreadyThere],
    ['ignored', s.ignoredFiles],
    ['unreadable', s.unreadableFiles],
    ['tooLarge', s.tooLarge],
    ['estimates', s.dateGuessed],
  ];
  return (
    <Outcome icon="ok" role="status" title={s.added > 0 ? t('title') : t('titleNone')} testId="photos-result">
      <ul className="flex flex-col gap-1 text-[15px]">
        {lines
          .filter(([, count]) => count > 0)
          .map(([key, count]) => (
            <li key={key}>{t(key, { count })}</li>
          ))}
      </ul>
      {result.delegatedToTakeout && <p className="text-t2 text-sm">{t('delegated')}</p>}
      <div>
        <PillButton variant="outlined" onClick={onAnother}>
          {t('another')}
        </PillButton>
      </div>
    </Outcome>
  );
}
