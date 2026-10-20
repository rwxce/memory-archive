'use client';

import { FileArchive } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSharedFiles } from '@/hooks/use-device-storage';
import { formatBytes } from './format';

/** Files received from the share sheet. Importing them arrives in Phase 4. */
export function SharedFiles() {
  const t = useTranslations('import');
  const locale = useLocale();
  const files = useSharedFiles();

  if (!files) return <p className="text-muted-foreground">{t('loading')}</p>;
  if (files.length === 0) return <p className="text-muted-foreground">{t('none')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg" data-testid="shared-count">
        {t('received', { count: files.length })}
      </p>
      <ul className="flex flex-col gap-2">
        {files.map((f) => (
          <li key={f.key} className="bg-card flex items-center gap-3 rounded-lg border p-3 text-sm">
            <FileArchive className="text-primary size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-muted-foreground shrink-0">{formatBytes(f.size, locale)}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">{t('next')}</p>
    </div>
  );
}
