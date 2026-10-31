'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Outcome } from '@/components/backup-check-cards';
import { PasswordPrompt } from '@/components/backup-password';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { PackProgressBar } from '@/components/sync-progress';
import type { ChangesPackImport, PackImportFailure } from '@/hooks/use-changes-pack-import';
import { Link } from '@/i18n/navigation';
import type { ImportChangesPackResult } from '@/lib/usecases/changes-pack-import';

const linkClass =
  'text-ac-tx focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]';

/** Which `sync.import.error.*` message explains why a pack was not merged. */
export function importErrorKey(code: PackImportFailure): string {
  switch (code) {
    case 'gap':
      return 'gap';
    case 'wrong-device':
      return 'wrongDevice';
    case 'own-pack':
      return 'ownPack';
    case 'not-a-pack':
    case 'invalid-manifest':
      return 'notPack';
    case 'not-an-archive':
    case 'unsafe-path':
    case 'duplicate-entry':
    case 'entry-mismatch':
    case 'integrity':
    case 'invalid-database':
      return 'damaged';
    case 'newer-format':
    case 'newer-schema':
      return 'newer';
    case 'limit-exceeded':
      return 'limit';
    case 'storage':
      return 'storage';
    case 'busy':
      return 'busy';
    case 'password-required':
      return 'passwordRequired';
    case 'encryption-unavailable':
      return 'encryptionUnavailable';
    default:
      return 'generic';
  }
}

/**
 * "Receive changes from another device": choose a file; a protected one asks for its password inline (the file stays with
 * the hook, so a wrong password only needs the password again); a backup picked here is pointed to Backup and restore. The
 * result says what was added and how many crossed edits were kept for later; it does not offer to resolve them.
 */
export function SyncImportCard({ pack, busy }: { pack: ChangesPackImport; busy: boolean }) {
  const t = useTranslations('sync.import');
  const picker = useRef<HTMLInputElement>(null);
  const { state } = pack;
  const working = state.status === 'working';
  const disabled = working || busy;

  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="sync-import-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="sync-import-title" tone="muted" className="tracking-widest">
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
          data-testid="sync-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file && !disabled) void pack.pick(file);
          }}
        />
        <PillButton aria-disabled={disabled || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" onClick={() => !disabled && picker.current?.click()}>
          {t('pick')}
        </PillButton>
      </div>

      {state.status === 'asking' && (
        <PasswordPrompt
          fileName={state.fileName}
          wrong={state.wrong}
          submitLabel={t('promptSubmit')}
          labels={{ title: t('promptTitle'), body: t('promptBody', { fileName: state.fileName }), cancel: t('promptCancel'), wrong: t('wrongPassword') }}
          onCancel={pack.reset}
          onSubmit={(password) => void pack.unlock(password)}
        />
      )}
      {state.status === 'working' && <PackProgressBar label={t('progressLabel')} progress={state.progress} />}
      {state.status === 'is-backup' && (
        <Outcome icon="quiet" testId="sync-import-result">
          <p className="break-words">{t('isBackup', { fileName: state.fileName })}</p>
          <Link href="/backup" className={linkClass}>
            {t('isBackupLink')}
          </Link>
        </Outcome>
      )}
      {state.status === 'failed' && (
        <Outcome icon="attention" title={t('errorTitle')} testId="sync-import-result">
          <p role="alert">{t(`error.${importErrorKey(state.code)}`)}</p>
          {(state.code === 'not-a-pack' || state.code === 'invalid-manifest') && (
            <Link href="/backup" className={linkClass}>
              {t('isBackupLink')}
            </Link>
          )}
        </Outcome>
      )}
      {state.status === 'done' && <MergeResult result={state.result} onAnother={() => picker.current?.click()} />}
    </SectionCard>
  );
}

/** What a merge added, in plain words, and the crossed edits kept for later. Lines with nothing to say are left out. */
function MergeResult({ result, onAnother }: { result: ImportChangesPackResult; onAnother: () => void }) {
  const t = useTranslations('sync.import');
  const c = result.counts;
  const lines: [string, number][] = [
    ['messagesAdded', c.messages.added],
    ['messagesSkipped', c.messages.skipped],
    ['people', c.profiles.added + c.profiles.updated],
    ['conversations', c.conversations.added + c.conversations.updated],
    ['notes', c.notes.added + c.notes.updated],
    ['favorites', c.favorites.added],
    ['removed', c.favorites.removed + c.notes.removed],
  ];
  const shown = lines.filter(([, count]) => count > 0);
  return (
    <Outcome icon="ok" title={t('resultTitle')} testId="sync-import-result">
      {shown.length === 0 && result.conflicts === 0 && result.batchOffers === 0 ? (
        <p>{t('nothingNew')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-[15px]">
          {shown.map(([key, count]) => (
            <li key={key}>{t(key, { count })}</li>
          ))}
        </ul>
      )}
      {result.conflicts > 0 && (
        <div className="flex flex-col gap-1" data-testid="sync-conflicts">
          <p>{t('conflicts', { count: result.conflicts })}</p>
          <p className="text-t2 text-sm">{t('conflictsLater')}</p>
        </div>
      )}
      {result.batchOffers > 0 && <p>{t('offers', { count: result.batchOffers })}</p>}
      <div>
        <PillButton variant="outlined" onClick={onAnother}>
          {t('another')}
        </PillButton>
      </div>
    </Outcome>
  );
}
