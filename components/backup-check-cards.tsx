'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PasswordPrompt } from '@/components/backup-password';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { TaskProgress } from '@/components/task-progress';
import { detectEncryptedBackup } from '@/hooks/is-encrypted-backup';
import type { useBackupFileCheck, useLibraryCheck } from '@/hooks/use-archive-checks';
import type { ArchiveErrorCode } from '@/lib/usecases/archive-backup';
import type { BackupVerification, LibraryIntegrity } from '@/lib/usecases/archive-health';
import { formatWhen } from './format';

/** The outcome of a check. It takes focus when it appears, so the result is read right away and keyboard users land on it. */
export function Outcome({ icon, title, children, testId, role }: { icon: 'ok' | 'attention' | 'quiet'; title?: ReactNode; children: ReactNode; testId: string; role?: 'status' | 'alert' }) {
  const box = useRef<HTMLDivElement>(null);
  // Take focus only if the person has not moved on: it is still on the button that started the check
  // (or on nothing at all). Never pull it away from something else they chose in the meantime.
  useEffect(() => {
    const element = box.current;
    const active = document.activeElement;
    if (element && (!active || active === document.body || element.closest('section')?.contains(active))) element.focus();
  }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role={role}
      data-testid={testId}
      className="bg-bg focus-visible:ring-ring/50 flex flex-col gap-2 rounded-[14px] p-3.5 outline-none focus-visible:ring-[3px]"
    >
      {title && (
        <h3 className="flex items-start gap-2 text-[15px] font-semibold">
          {icon === 'ok' && <CircleCheck className="text-ac-tx mt-px size-[18px] shrink-0" aria-hidden />}
          {icon === 'attention' && <CircleAlert className="text-co mt-px size-[18px] shrink-0" aria-hidden />}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

/** How many of each kind, from the problems the check kept. */
function countByKind<K extends string>(problems: { kind: K }[]): [K, number][] {
  const counts = new Map<K, number>();
  for (const { kind } of problems) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts];
}

/**
 * The progress while a check runs: the bar and the exact sentence on screen, and a separate live
 * region for screen readers that only changes at coarse steps (`announce`), not for every file.
 */
export function Running({ label, text, announce, value }: { label: string; text: string; announce: string; value?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <TaskProgress label={label} text={text} value={value} />
      <p aria-hidden className="text-t2 text-sm break-words">
        {text}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  );
}

/** What a screen reader hears: nothing new until the next quarter. */
export function announceStep(percent: number | undefined): number | undefined {
  return percent === undefined ? undefined : Math.min(100, Math.floor(percent / 25) * 25);
}

const percentOf = (done: number, total: number) => (total > 0 ? (done / total) * 100 : undefined);

function failureKey(code: ArchiveErrorCode | 'unknown') {
  return code === 'busy' ? 'busy' : 'generic';
}

/** "Check my archive": every stored file is present and intact. Start, then Stop in the same button so focus stays put. */
export function LibraryCheckCard({ check, busy }: { check: ReturnType<typeof useLibraryCheck>; busy: boolean }) {
  const t = useTranslations('backup.check');
  const ta = useTranslations('archive.error');
  const { state } = check;
  const running = state.status === 'running';
  const progress = state.status === 'running' ? state.progress : undefined;
  const text = progress ? t('progress', { done: progress.done, total: progress.total }) : t('starting');
  const step = progress ? announceStep(percentOf(progress.bytesDone, progress.bytesTotal)) : undefined;

  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="backup-check-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="backup-check-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>
      <div>
        <PillButton
          variant={running ? 'outlined' : 'primary'}
          aria-disabled={(!running && busy) || undefined}
          onClick={() => (running ? check.cancel() : !busy && void check.run())}
        >
          {running ? t('cancel') : state.status === 'idle' ? t('run') : t('again')}
        </PillButton>
      </div>
      {running && (
        <Running
          label={t('progressLabel')}
          text={text}
          announce={step === undefined ? t('starting') : t('announce', { percent: step })}
          value={progress ? percentOf(progress.bytesDone, progress.bytesTotal) : undefined}
        />
      )}
      {state.status === 'cancelled' && (
        <Outcome icon="quiet" testId="library-check-result">
          <p>{t('cancelled')}</p>
        </Outcome>
      )}
      {state.status === 'failed' && (
        <Outcome icon="quiet" testId="library-check-result">
          <p>{ta(failureKey(state.code))}</p>
        </Outcome>
      )}
      {state.status === 'done' && <LibraryResult result={state.result} />}
    </SectionCard>
  );
}

function LibraryResult({ result }: { result: LibraryIntegrity }) {
  const t = useTranslations('backup.check');
  if (result.ok) {
    return (
      <Outcome icon="ok" title={t('okTitle')} testId="library-check-result">
        <p>{t('ok', { count: result.checkedFiles })}</p>
      </Outcome>
    );
  }
  return (
    <Outcome icon="attention" title={t('problemTitle')} testId="library-check-result">
      <p>{t('problems', { count: result.problemCount })}</p>
      <ul className="list-disc ps-5 text-sm">
        {(Object.entries(result.countsByKind) as [keyof typeof result.countsByKind & string, number][]).map(([kind, count]) => (
          <li key={kind}>{t(`kinds.${kind}`, { count })}</li>
        ))}
      </ul>
    </Outcome>
  );
}

/** Which `backup.file.refusal.*` message explains why a file could not be examined at all. */
export function refusalKey(code: ArchiveErrorCode): 'notArchive' | 'damaged' | 'newer' | 'limit' | 'wrongPassword' | 'unavailable' | 'generic' {
  switch (code) {
    case 'wrong-password':
      return 'wrongPassword';
    case 'encryption-unavailable':
      return 'unavailable';
    case 'not-an-archive':
      return 'notArchive';
    case 'invalid-manifest':
    case 'unsafe-path':
    case 'duplicate-entry':
    case 'entry-mismatch':
    case 'invalid-database':
    case 'integrity':
      return 'damaged';
    case 'newer-format':
    case 'newer-schema':
      return 'newer';
    case 'limit-exceeded':
      return 'limit';
    default:
      return 'generic';
  }
}

/**
 * "Check a backup file": pick a backup and verify it without restoring. A password-protected file asks for its
 * password right here; a wrong one keeps the file and asks again. Nothing about the password is kept.
 */
export function FileCheckCard({ check }: { check: ReturnType<typeof useBackupFileCheck> }) {
  const t = useTranslations('backup.file');
  const ta = useTranslations('archive.error');
  const picker = useRef<HTMLInputElement>(null);
  /** A protected backup waiting for its password. */
  const [asking, setAsking] = useState<File | null>(null);
  const { state } = check;
  const running = state.status === 'running';
  const wrong = state.status === 'done' && state.result.refusal === 'wrong-password';
  const finished = state.status === 'done' || state.status === 'failed' || state.status === 'cancelled';
  useEffect(() => {
    if (finished && !wrong) setAsking(null);
  }, [state, finished, wrong]);
  const progress = state.status === 'running' ? state.progress : undefined;
  const text = progress ? (progress.phase === 'decrypting' ? t('decrypting') : t('progress', { done: progress.done, total: progress.total })) : t('starting');
  const step = progress ? announceStep(percentOf(progress.done, progress.total)) : undefined;

  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="backup-file-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="backup-file-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>
      <div>
        <input
          ref={picker}
          type="file"
          accept=".zip,.mabackup,application/zip"
          hidden
          data-testid="verify-input"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            setAsking(null);
            check.reset();
            if (await detectEncryptedBackup(file)) setAsking(file);
            else void check.run(file);
          }}
        />
        <PillButton variant={running ? 'outlined' : 'primary'} onClick={() => (running ? check.cancel() : picker.current?.click())}>
          {running ? t('cancel') : state.status === 'idle' ? t('pick') : t('another')}
        </PillButton>
      </div>
      {running && (
        <Running
          label={t('progressLabel')}
          text={text}
          announce={step === undefined ? t('starting') : t('announce', { percent: step })}
          value={progress ? percentOf(progress.done, progress.total) : undefined}
        />
      )}
      {state.status === 'cancelled' && (
        <Outcome icon="quiet" testId="file-check-result">
          <p>{t('cancelled')}</p>
        </Outcome>
      )}
      {state.status === 'failed' && (
        <Outcome icon="quiet" testId="file-check-result">
          <p>{ta('generic')}</p>
        </Outcome>
      )}
      {asking && !running && (
        <PasswordPrompt fileName={asking.name} wrong={wrong} submitLabel={t('checkPrompt')} onCancel={() => setAsking(null)} onSubmit={(password) => void check.run(asking, password)} />
      )}
      {state.status === 'done' && !wrong && <FileResult result={state.result} />}
    </SectionCard>
  );
}

function FileResult({ result }: { result: BackupVerification }) {
  const t = useTranslations('backup.file');
  const locale = useLocale();
  if (result.refusal) {
    return (
      <Outcome icon="attention" title={t('refusalTitle')} testId="file-check-result">
        <p>{t(`refusal.${refusalKey(result.refusal)}`)}</p>
      </Outcome>
    );
  }
  if (result.ok) {
    return (
      <Outcome icon="ok" title={t('okTitle')} testId="file-check-result">
        <p>{t('ok', { count: result.checkedEntries })}</p>
        {result.encrypted && <p className="text-t2 text-sm">{t('encryptedOk')}</p>}
        {result.createdAt && result.appVersion && (
          <p className="text-t2 text-sm">{t('meta', { date: formatWhen(result.createdAt, locale).absolute, version: result.appVersion })}</p>
        )}
      </Outcome>
    );
  }
  return (
    <Outcome icon="attention" title={t('problemTitle')} testId="file-check-result">
      <p>{t('problems', { count: result.problemCount })}</p>
      {result.problems.some((p) => p.entry === 'database') && <p>{t('databaseDamaged')}</p>}
      <ul className="list-disc ps-5 text-sm">
        {countByKind(result.problems).map(([kind, count]) => (
          <li key={kind}>{t(`kinds.${kind}`, { count })}</li>
        ))}
      </ul>
      {result.problemCount > result.problems.length && <p className="text-t2 text-sm">{t('capped', { shown: result.problems.length, total: result.problemCount })}</p>}
    </Outcome>
  );
}
