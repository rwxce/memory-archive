'use client';

import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { useArchiveSizes } from '@/hooks/use-archive-sizes';
import { useStorageStatus } from '@/hooks/use-device-storage';
import { formatBytes } from './format';

/** Settings: how much space the archive uses here (split photos/videos vs messages/audio when known), and whether it is protected. */
export function StorageCard() {
  const t = useTranslations('settings.storage');
  const locale = useLocale();
  const status = useStorageStatus();
  const sizes = useArchiveSizes();

  const known = status && status.usage !== null && status.quota !== null && status.quota > 0;
  const quota = known ? status.quota! : 0;
  const share = (bytes: number) => (quota > 0 ? Math.min(100, Math.max(bytes > 0 ? 0.5 : 0, (bytes / quota) * 100)) : 0);
  const percent = known ? Math.round(Math.min(100, (status.usage! / quota) * 100)) : 0;
  // Without the breakdown (library not open, or unreadable) the bar is one solid segment.
  const photos = sizes ? share(sizes.photosVideos) : share(known ? status.usage! : 0);
  const messages = sizes ? share(sizes.messagesAndAudio) : 0;

  return (
    <SectionCard tone="soft" className="gap-3.5 p-[18px]" aria-labelledby="storage-title">
      <Eyebrow as="h2" id="storage-title" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      {!status ? (
        <p data-testid="storage-usage">{t('loading')}</p>
      ) : !known ? (
        <p data-testid="storage-usage">{t('unknown')}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2" data-testid="storage-usage">
            <span className="font-display text-5xl leading-none">{formatBytes(status.usage!, locale)}</span>
            <span className="text-t2 text-sm">{t('available', { total: formatBytes(quota, locale) })}</span>
          </p>
          <div role="img" aria-label={t('meter', { percent })} className="bg-bg flex h-3 overflow-hidden rounded-md">
            <div className="bg-ac" style={{ width: `${photos}%` }} />
            <div className="bg-co" style={{ width: `${messages}%` }} />
          </div>
          {sizes && (
            <ul className="text-t2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="bg-ac size-2 rounded-full" />
                {t('photos')}
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="bg-co size-2 rounded-full" />
                {t('messages')}
              </li>
            </ul>
          )}
        </>
      )}
      {status && status.persisted !== null && (
        <p className="bg-bg flex items-start gap-2.5 rounded-[14px] p-3 text-[13px] leading-snug" data-testid="storage-persisted">
          {status.persisted ? (
            <ShieldCheck className="text-ac-tx mt-px size-[18px] shrink-0" aria-hidden />
          ) : (
            <ShieldAlert className="text-ac-tx mt-px size-[18px] shrink-0" aria-hidden />
          )}
          {status.persisted ? t('persisted') : t('notPersisted')}
        </p>
      )}
    </SectionCard>
  );
}
