'use client';

import { useTranslations } from 'next-intl';
import type { ArchiveBackupState } from '@/hooks/use-archive-backup';

type Failed = Extract<ArchiveBackupState, { status: 'failed' }>;

/** Which `archive.error.*` message explains an archive failure. */
export function archiveErrorKey(code: Failed['code']): string {
  switch (code) {
    case 'busy':
      return 'busy';
    case 'target-not-empty':
      return 'notEmpty';
    case 'not-an-archive':
    case 'invalid-manifest':
    case 'unsafe-path':
    case 'duplicate-entry':
    case 'entry-mismatch':
    case 'invalid-database':
    case 'integrity':
      return 'invalid';
    case 'newer-format':
    case 'newer-schema':
      return 'newer';
    case 'limit-exceeded':
      return 'limit';
    case 'blob-missing':
      return 'missingMedia';
    case 'storage':
      return 'storage';
    default:
      return 'generic';
  }
}

/**
 * The calm sentence for a backup or restore: progress while it runs, the outcome after. Failures
 * are announced as alerts; everything else politely. Renders an empty live region when idle, so
 * the region exists before the first message.
 */
export function ArchiveStatus({ state, className }: { state: ArchiveBackupState; className?: string }) {
  const t = useTranslations('archive');
  let text = '';
  if (state.status === 'working') {
    const p = state.progress;
    text = p.phase === 'media' ? t('progress.media', { done: p.done, total: p.total }) : t(`progress.${p.phase}`);
  } else if (state.status === 'done') text = t(`done.${state.kind}`);
  else if (state.status === 'failed') text = t(`error.${archiveErrorKey(state.code)}`);
  const failed = state.status === 'failed';
  return (
    <p role={failed ? 'alert' : 'status'} aria-live={failed ? undefined : 'polite'} className={className ?? 'text-sm break-words empty:hidden'}>
      {text}
    </p>
  );
}
