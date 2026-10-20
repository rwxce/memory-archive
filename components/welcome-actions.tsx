'use client';

import { useState } from 'react';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { usePrepareStorage } from '@/hooks/use-device-storage';

/**
 * First-run choices. *Start* asks the browser to keep this device's archive
 * (persistent storage); the library itself and archive restore (*Open an
 * archive*) land in later versions, and the notice says so calmly.
 */
export function WelcomeActions() {
  const t = useTranslations('welcome');
  const prepareStorage = usePrepareStorage();
  const [notice, setNotice] = useState('');

  const start = async () => {
    await prepareStorage();
    setNotice(t('comingSoon'));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" className="sm:flex-1" onClick={start}>
          <Sparkles aria-hidden />
          {t('start')}
        </Button>
        <Button size="lg" variant="outline" className="sm:flex-1" onClick={() => setNotice(t('comingSoon'))}>
          <FolderOpen aria-hidden />
          {t('open')}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">{t('openHint')}</p>
      <p role="status" aria-live="polite" className="min-h-5 text-sm">
        {notice}
      </p>
    </div>
  );
}
