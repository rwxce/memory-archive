'use client';

import { useState } from 'react';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * First-run choices. Both actions are placeholders until the library (Start)
 * and archive restore (Open an archive) land; they say so calmly instead of
 * doing nothing.
 */
export function WelcomeActions() {
  const t = useTranslations('welcome');
  const [notice, setNotice] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" className="sm:flex-1" onClick={() => setNotice(t('comingSoon'))}>
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
