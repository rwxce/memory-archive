'use client';

import { useState } from 'react';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { usePrepareStorage } from '@/hooks/use-device-storage';
import { useRouter } from '@/i18n/navigation';

/**
 * First-run choices. *Start* asks the browser to keep this device's archive
 * (persistent storage) and goes to People, where the first person is added.
 * Archive restore (*Open an archive*) lands in a later version; the notice
 * says so calmly.
 */
export function WelcomeActions() {
  const t = useTranslations('welcome');
  const prepareStorage = usePrepareStorage();
  const router = useRouter();
  const [notice, setNotice] = useState('');

  const start = async () => {
    await prepareStorage();
    router.push('/people');
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
