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
    case 'safety-backup-failed':
      return 'safetyBackupFailed';
    case 'changed-during-replace':
      return 'changedDuringReplace';
    case 'cancelled':
      return 'cancelled';
    case 'password-required':
      return 'passwordRequired';
    case 'wrong-password':
      return 'wrongPassword';
    case 'encryption-unavailable':
      return 'encryptionUnavailable';
    default:
      return 'generic';
  }
}

/** "Step 1 of 2: saving a safety copy" plus the usual progress sentence, for the bar and the status line. */
export function archiveProgressText(
  t: (key: string, values?: Record<string, number | string>) => string,
  state: Extract<ArchiveBackupState, { status: 'working' }>,
): string {
  const p = state.progress;
  const text = p.phase === 'media' ? t('progress.media', { done: p.done, total: p.total }) : t(`progress.${p.phase}`);
  return state.stage ? `${t(`replace.stage.${state.stage}`)} ${text}` : text;
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
    text = archiveProgressText(t, state);
  } else if (state.status === 'done') {
    text = t(`done.${state.kind}`);
    // A backup says whether it needs a password. A plain one is private: anyone with the file can read it.
    if (state.kind === 'backup') text = state.encrypted ? t('done.backupEncrypted') : `${text} ${t('done.backupPrivate')}`;
  }
  if (state.status === 'failed') text = t(`error.${archiveErrorKey(state.code)}`);
  // A safety copy already handed to the browser: say where it is, on success and on a failure after it.
  const kept = state.status === 'done' || state.status === 'failed' ? state.safetyBackupFileName : undefined;
  if (kept) text = `${text} ${t('replace.safetyKept', { fileName: kept })}`;
  const failed = state.status === 'failed';
  return (
    <p role={failed ? 'alert' : 'status'} aria-live={failed ? undefined : 'polite'} className={className ?? 'text-sm break-words empty:hidden'}>
      {text}
    </p>
  );
}
