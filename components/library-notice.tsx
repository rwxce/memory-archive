'use client';

import { AlertCircle, Loader } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { LibraryState } from '@/hooks/use-library';

/**
 * What to show instead of a screen while the library is opening or cannot be
 * opened. Calm wording; always says nothing was lost and offers a retry.
 */
export function LibraryNotice({ state, onRetry }: { state: Exclude<LibraryState, { status: 'ready' }>; onRetry: () => void }) {
  const t = useTranslations('library');

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 py-6">
        <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
        {t('loading')}
      </p>
    );
  }

  const key = state.status === 'error' ? 'error' : state.problem === 'newer-version' ? 'newerVersion' : 'inUse';
  return (
    <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
      <h2 className="flex items-start gap-2 text-lg font-semibold">
        <AlertCircle className="text-primary mt-1 size-5 shrink-0" aria-hidden />
        {t(`${key}.title`)}
      </h2>
      <p className="text-muted-foreground leading-relaxed">{t(`${key}.body`)}</p>
      <div>
        <Button variant="outline" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    </section>
  );
}
