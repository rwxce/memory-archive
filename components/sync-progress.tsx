'use client';

import { useTranslations } from 'next-intl';
import { announceStep, Running } from '@/components/backup-check-cards';
import type { PackProgress } from '@/hooks/throttle-progress';

/** The sentence for where a pack export or merge is ("Copying files: 3 of 12"), shared with the backup's wording. */
function usePackProgressText(progress: PackProgress): string {
  const t = useTranslations('archive.progress');
  return progress.phase === 'media' ? t('media', { done: progress.done, total: progress.total }) : t(progress.phase);
}

/** The bar and its sentence while a pack is made or merged; a screen reader hears it only every quarter. */
export function PackProgressBar({ label, progress }: { label: string; progress: PackProgress }) {
  const t = useTranslations('sync');
  const text = usePackProgressText(progress);
  const percent = 'total' in progress && progress.total > 0 ? (progress.done / progress.total) * 100 : undefined;
  return <Running label={label} text={text} announce={percent === undefined ? text : t('progressAnnounce', { percent: announceStep(percent) ?? 0 })} value={percent} />;
}
