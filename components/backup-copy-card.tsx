'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveStatus } from '@/components/archive-status';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { TaskProgress } from '@/components/task-progress';
import type { ArchiveBackup } from '@/hooks/use-archive-backup';

/**
 * Backup and restore: the full backup button and "open a backup". Opening is only offered on an empty
 * archive (`canRestore`); otherwise a calm note says why and that the archive was not touched.
 * `busy` is true while any other archive task (a check) runs, so two never overlap.
 */
export function BackupCopyCard({ backup, canRestore, busy }: { backup: ArchiveBackup; canRestore: boolean | undefined; busy: boolean }) {
  const t = useTranslations('backup.copy');
  const ta = useTranslations('archive');
  const picker = useRef<HTMLInputElement>(null);
  const { state } = backup;
  const working = state.status === 'working';
  const disabled = working || busy;
  const progress = state.status === 'working' ? state.progress : undefined;
  const percent = progress?.phase === 'media' && progress.total > 0 ? (progress.done / progress.total) * 100 : undefined;
  const text = progress ? (progress.phase === 'media' ? ta('progress.media', { done: progress.done, total: progress.total }) : ta(`progress.${progress.phase}`)) : '';

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
        <p className="text-t2 text-sm leading-relaxed">{t('restoreDescription')}</p>
      </div>
      {canRestore === false ? (
        <p className="bg-bg rounded-[14px] p-3 text-sm leading-relaxed" data-testid="restore-not-empty">
          {t('restoreNotEmpty')}
        </p>
      ) : (
        <div>
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip"
            hidden
            data-testid="restore-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file && !disabled) void backup.restore(file);
            }}
          />
          <PillButton variant="outlined" aria-disabled={disabled || canRestore === undefined || undefined} onClick={() => !disabled && canRestore && picker.current?.click()}>
            {t('restore')}
          </PillButton>
        </div>
      )}

      {progress && <TaskProgress label={t('progressLabel')} text={text} value={percent} />}
      <ArchiveStatus state={state} />
    </SectionCard>
  );
}
