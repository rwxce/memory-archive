'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveStatus, archiveProgressText } from '@/components/archive-status';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { ReplaceBackupDialog } from '@/components/replace-backup-dialog';
import { SectionCard } from '@/components/section-card';
import { TaskProgress } from '@/components/task-progress';
import type { ArchiveBackup } from '@/hooks/use-archive-backup';
import type { ArchiveUsageState } from '@/hooks/use-archive-usage';

/**
 * Backup and restore: the full backup button and "open a backup". On an empty archive (`canRestore`) the
 * chosen backup is opened straight away. On an archive that has data, the same card offers "replace my
 * archive with a backup": the chosen file waits behind a confirmation dialog, and only the explicit
 * confirm starts it (a safety copy is downloaded first). While replacing, Stop works until the swap begins.
 * `busy` is true while any other archive task (a check) runs, so two never overlap.
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
  const { state } = backup;
  const working = state.status === 'working';
  const disabled = working || busy;
  const progress = state.status === 'working' ? state.progress : undefined;
  const percent = progress?.phase === 'media' && progress.total > 0 ? (progress.done / progress.total) * 100 : undefined;
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
      <div>
        <PillButton aria-disabled={disabled || undefined} onClick={() => !disabled && void backup.backup()}>
          {t('backup')}
        </PillButton>
      </div>

      <div className="border-line flex flex-col gap-1.5 border-t pt-4">
        <h3 className="text-[15px] font-medium">{t('restoreTitle')}</h3>
        <p className="text-t2 text-sm leading-relaxed">{replacing ? t('replaceDescription') : t('restoreDescription')}</p>
      </div>
      <div>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          hidden
          data-testid={replacing ? 'replace-input' : 'restore-input'}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file || disabled) return;
            if (replacing) setPending(file);
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
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const file = pending;
          setPending(null);
          if (file) void backup.replace(file);
        }}
      />

      {progress && <TaskProgress label={t('progressLabel')} text={text} value={percent} />}
      {stoppable && (
        <div>
          <PillButton variant="outlined" onClick={backup.cancel}>
            {t('cancel')}
          </PillButton>
        </div>
      )}
      <ArchiveStatus state={state} />
    </SectionCard>
  );
}
