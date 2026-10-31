'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveStatus, archiveProgressText } from '@/components/archive-status';
import { BackupMaker, PasswordPrompt } from '@/components/backup-password';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { ReplaceBackupDialog } from '@/components/replace-backup-dialog';
import { SectionCard } from '@/components/section-card';
import { TaskProgress } from '@/components/task-progress';
import type { ArchiveBackup } from '@/hooks/use-archive-backup';
import { detectEncryptedBackup } from '@/hooks/is-encrypted-backup';
import type { ArchiveUsageState } from '@/hooks/use-archive-usage';

/**
 * Backup and restore: the full backup button and "open a backup". On an empty archive (`canRestore`) the
 * chosen backup is opened straight away. On an archive that has data, the same card offers "replace my
 * archive with a backup": the chosen file waits behind a confirmation dialog, and only the explicit
 * confirm starts it (a safety copy is downloaded first). While replacing, Stop works until the swap begins.
 * `busy` is true while any other archive task (a check) runs, so two never overlap.
 *
 * Backups can be protected with a password (`BackupMaker`). After a file is picked it is looked at: a protected
 * one asks for its password (inline when opening, inside the confirmation when replacing); a plain one goes on
 * exactly as before. A wrong password keeps the chosen file and asks again; the password is never stored.
 */
export function BackupCopyCard({
  backup,
  canRestore,
  busy,
  usage,
}: {
  backup: ArchiveBackup;
  canRestore: boolean | undefined;
  busy: boolean;
  usage?: ArchiveUsageState;
}) {
  const t = useTranslations('backup.copy');
  const ta = useTranslations('archive');
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [pendingEncrypted, setPendingEncrypted] = useState(false);
  /** A protected backup chosen to open, waiting for its password. */
  const [asking, setAsking] = useState<File | null>(null);
  /** The password was wrong: the prompt or dialog says so, and the status line stays quiet about it. */
  const [wrong, setWrong] = useState(false);
  /** The file a replace was confirmed for, kept so a wrong password can reopen the confirmation for it. */
  const confirmed = useRef<File | null>(null);
  const { state } = backup;
  const kind = state.status === 'failed' ? state.kind : undefined;
  const failure = state.status === 'failed' ? state.code : undefined;
  const finished = state.status === 'done' || state.status === 'failed';
  useEffect(() => {
    if (failure === 'wrong-password') {
      setWrong(true);
      if (kind === 'replace' && confirmed.current) {
        setPending(confirmed.current);
        setPendingEncrypted(true);
      }
    } else if (finished) {
      setAsking(null);
      confirmed.current = null;
    }
  }, [state, failure, kind, finished]);
  const working = state.status === 'working';
  const disabled = working || busy;
  const progress = state.status === 'working' ? state.progress : undefined;
  const counted = progress && progress.phase !== 'preparing' && progress.phase !== 'finishing';
  const percent = counted && progress.total > 0 ? (progress.done / progress.total) * 100 : undefined;
  const text = state.status === 'working' ? archiveProgressText(ta, state) : '';
  const stoppable = state.status === 'working' && state.kind === 'replace' && state.cancellable !== false;
  const replacing = canRestore === false;

  return (
    <SectionCard className="gap-4 p-[18px]" aria-labelledby="backup-copy-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="backup-copy-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>
      <BackupMaker disabled={disabled} onBackup={(password) => void backup.backup({ password })} />

      <div className="border-line flex flex-col gap-1.5 border-t pt-4">
        <h3 className="text-[15px] font-medium">{t('restoreTitle')}</h3>
        <p className="text-t2 text-sm leading-relaxed">{replacing ? t('replaceDescription') : t('restoreDescription')}</p>
      </div>
      <div>
        <input
          ref={picker}
          type="file"
          accept=".zip,.mabackup,application/zip"
          hidden
          data-testid={replacing ? 'replace-input' : 'restore-input'}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file || disabled) return;
            setWrong(false);
            setAsking(null);
            const encrypted = await detectEncryptedBackup(file);
            if (replacing) {
              setPendingEncrypted(encrypted);
              setPending(file);
            } else if (encrypted) setAsking(file);
            else void backup.restore(file);
          }}
        />
        <PillButton variant="outlined" aria-disabled={disabled || canRestore === undefined || undefined} onClick={() => !disabled && canRestore !== undefined && picker.current?.click()}>
          {replacing ? t('replace') : t('restore')}
        </PillButton>
      </div>
      <ReplaceBackupDialog
        file={pending}
        counts={usage?.status === 'ready' ? usage.usage.counts : undefined}
        encrypted={pendingEncrypted}
        wrong={wrong}
        onCancel={() => setPending(null)}
        onConfirm={(password) => {
          const file = pending;
          setPending(null);
          if (!file) return;
          confirmed.current = file;
          void backup.replace(file, password);
        }}
      />
      {asking && !working && (
        <PasswordPrompt
          fileName={asking.name}
          wrong={wrong}
          submitLabel={t('restorePrompt')}
          onCancel={() => setAsking(null)}
          onSubmit={(password) => void backup.restore(asking, password)}
        />
      )}

      {progress && <TaskProgress label={t('progressLabel')} text={text} value={percent} />}
      {stoppable && (
        <div>
          <PillButton variant="outlined" onClick={backup.cancel}>
            {t('cancel')}
          </PillButton>
        </div>
      )}
      <ArchiveStatus state={wrong && failure === 'wrong-password' ? { status: 'idle' } : state} />
    </SectionCard>
  );
}
