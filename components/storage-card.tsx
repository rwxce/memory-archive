'use client';

import { HardDrive, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useStorageStatus } from '@/hooks/use-device-storage';
import { formatBytes } from './format';

/** Settings: how much space the archive uses here, and whether it is protected. */
export function StorageCard() {
  const t = useTranslations('settings.storage');
  const locale = useLocale();
  const status = useStorageStatus();

  let usage: string;
  if (!status) usage = t('loading');
  else if (status.usage === null || status.quota === null) usage = t('unknown');
  else usage = t('usage', { used: formatBytes(status.usage, locale), total: formatBytes(status.quota, locale) });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription className="flex items-center gap-2" data-testid="storage-usage">
          <HardDrive className="size-4 shrink-0" aria-hidden />
          {usage}
        </CardDescription>
      </CardHeader>
      {status?.persisted !== null && status !== undefined && (
        <CardContent>
          <p className="text-muted-foreground flex items-start gap-2 text-sm" data-testid="storage-persisted">
            {status.persisted ? (
              <ShieldCheck className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            {status.persisted ? t('persisted') : t('notPersisted')}
          </p>
        </CardContent>
      )}
    </Card>
  );
}
