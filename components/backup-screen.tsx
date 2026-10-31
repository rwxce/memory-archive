'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { BackupCopyCard } from '@/components/backup-copy-card';
import { FileCheckCard, LibraryCheckCard } from '@/components/backup-check-cards';
import { BackupUsageCard } from '@/components/backup-usage-card';
import { LibraryNotice } from '@/components/library-notice';
import { PageTitle } from '@/components/page-title';
import { Shell } from '@/components/screen-shell';
import { useBackupFileCheck, useLibraryCheck } from '@/hooks/use-archive-checks';
import { useArchiveBackup } from '@/hooks/use-archive-backup';
import { useArchiveUsage } from '@/hooks/use-archive-usage';
import { useLibrary } from '@/hooks/use-library';

/**
 * Backup and restore (PRD screen 9): what the archive holds and uses, a full backup, opening a
 * backup into an empty archive, and two read-only checks (the archive on this device, and a backup
 * file). The library opens here because all of it needs it, except checking a file. One archive task
 * runs at a time: while a backup, restore or library check runs, the others wait.
 */
export function BackupScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell back={{ href: '/settings' }}>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <BackupContent />;
}

function BackupContent() {
  const t = useTranslations('backup');
  const tn = useTranslations('settings');
  const backup = useArchiveBackup();
  const libraryCheck = useLibraryCheck();
  const fileCheck = useBackupFileCheck();
  const { state: usage, reload } = useArchiveUsage();

  // A restore fills the archive: read the counts again.
  const finished = backup.state.status === 'done' || backup.state.status === 'failed';
  const reloaded = useRef(false);
  useEffect(() => {
    if (finished && !reloaded.current) reload();
    reloaded.current = finished;
  }, [finished, reload]);

  // Emptiness is the library's own test (no row in any table). If the usage could not be read, the
  // attempt is allowed: restoring itself refuses a library that has data, and says so.
  const canRestore = usage.status === 'ready' ? usage.usage.libraryEmpty : usage.status === 'error' ? true : undefined;

  return (
    <Shell back={{ href: '/settings', label: tn('title') }}>
      <div className="flex flex-col gap-1.5">
        <PageTitle>{t('title')}</PageTitle>
        <p className="text-t2 leading-relaxed">{t('intro')}</p>
      </div>
      <BackupUsageCard state={usage} />
      <BackupCopyCard backup={backup} canRestore={canRestore} busy={libraryCheck.state.status === 'running'} />
      <LibraryCheckCard check={libraryCheck} busy={backup.state.status === 'working'} />
      <FileCheckCard check={fileCheck} />
    </Shell>
  );
}
