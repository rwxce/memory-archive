'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { useStorageStatus } from '@/hooks/use-device-storage';
import type { ArchiveUsageState } from '@/hooks/use-archive-usage';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { formatBytes } from './format';

/** Backup and restore: how many people, conversations, messages and files the archive holds, the bytes per kind, and the device's room. */
export function BackupUsageCard({ state }: { state: ArchiveUsageState }) {
  const t = useTranslations('backup.usage');
  const ts = useTranslations('settings.storage');
  const locale = useLocale();
  const device = useStorageStatus();

  return (
    <SectionCard tone="soft" className="gap-4 p-[18px]" aria-labelledby="backup-usage-title">
      <Eyebrow as="h2" id="backup-usage-title" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      {state.status === 'loading' && <p role="status">{t('loading')}</p>}
      {state.status === 'error' && <p role="alert">{t('failed')}</p>}
      {state.status === 'ready' && (
        <>
          <ul aria-label={t('counts')} className="grid gap-x-4 gap-y-1 text-[15px] sm:grid-cols-2" data-testid="backup-counts">
            <li>{t('people', { count: state.usage.counts.profiles })}</li>
            <li>{t('conversations', { count: state.usage.counts.conversations })}</li>
            <li>{t('messages', { count: state.usage.counts.messages })}</li>
            <li>{t('files', { count: state.usage.counts.mediaFiles })}</li>
          </ul>
          <dl aria-label={t('sizes')} className="flex flex-col gap-1.5 text-sm" data-testid="backup-bytes">
            {(['media', 'thumbnails', 'database', 'searchIndex'] as const).map((kind) => (
              <div key={kind} className="flex items-baseline justify-between gap-3">
                <dt className="text-t2 min-w-0 break-words">{t(kind)}</dt>
                <dd className="shrink-0 font-medium tabular-nums">{formatBytes(state.usage.bytes[kind], locale)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {device && (
        <p className="text-t2 text-sm" data-testid="backup-device">
          {device.usage !== null && device.quota !== null && device.quota > 0
            ? t('device', { used: formatBytes(device.usage, locale), total: formatBytes(device.quota, locale) })
            : t('deviceUnknown')}
        </p>
      )}
      {device && device.persisted !== null && (
        <p className="bg-bg flex items-start gap-2.5 rounded-[14px] p-3 text-[13px] leading-snug" data-testid="backup-persisted">
          {device.persisted ? (
            <ShieldCheck className="text-ac-tx mt-px size-[18px] shrink-0" aria-hidden />
          ) : (
            <ShieldAlert className="text-ac-tx mt-px size-[18px] shrink-0" aria-hidden />
          )}
          {device.persisted ? ts('persisted') : ts('notPersisted')}
        </p>
      )}
    </SectionCard>
  );
}
