'use client';

import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { LoadingNote } from '@/components/screen-states';
import type { LibraryState } from '@/hooks/use-library';

/**
 * What to show instead of a screen while the library is opening or cannot be
 * opened. Calm wording; always says nothing was lost and offers a retry.
 */
export function LibraryNotice({ state, onRetry }: { state: Exclude<LibraryState, { status: 'ready' }>; onRetry: () => void }) {
  const t = useTranslations('library');

  if (state.status === 'loading') {
    return <LoadingNote>{t('loading')}</LoadingNote>;
  }

  const key = state.status === 'error' ? 'error' : state.problem === 'newer-version' ? 'newerVersion' : 'inUse';
  return (
    <SectionCard role="alert">
      <h2 className="font-display text-name flex items-start gap-2">
        <AlertCircle className="text-co mt-1 size-5 shrink-0" aria-hidden />
        {t(`${key}.title`)}
      </h2>
      <p className="text-t2 leading-relaxed">{t(`${key}.body`)}</p>
      <div>
        <PillButton variant="outlined" onClick={onRetry}>
          {t('retry')}
        </PillButton>
      </div>
    </SectionCard>
  );
}
