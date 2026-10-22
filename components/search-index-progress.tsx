'use client';

import { Loader } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/** The spoken progress moves in steps of this many percent, so a screen reader is not flooded. */
const ANNOUNCE_STEP = 20;

/**
 * "Preparing search…" with a progress bar and a Cancel. The visible numbers update with every chunk;
 * the live region only speaks every `ANNOUNCE_STEP` percent. The words differ for an index that was
 * never built and one that is catching up (after an undo or a restore), and both are calm.
 */
export function SearchIndexProgress({ reason, done, total, onCancel }: { reason: 'not-built' | 'stale'; done: number; total: number; onCancel: () => void }) {
  const t = useTranslations('search');
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  const bucket = Math.floor(percent / ANNOUNCE_STEP) * ANNOUNCE_STEP;
  const key = reason === 'stale' ? 'refreshing' : 'preparing';
  return (
    <section className="bg-card flex flex-col gap-3 rounded-xl border p-4" aria-labelledby="search-progress-title">
      <p id="search-progress-title" className="flex items-center gap-2 font-medium">
        <Loader className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
        {t(`${key}Title`)}
      </p>
      <progress max={Math.max(total, 1)} value={Math.min(done, Math.max(total, 1))} aria-labelledby="search-progress-title" className="accent-primary h-2 w-full" />
      <p className="text-muted-foreground text-sm">{t('progress', { done, total })}</p>
      <p className="text-muted-foreground text-sm leading-relaxed">{t(`${key}Note`)}</p>
      <p role="status" className="sr-only">
        {t('progressSpoken', { percent: bucket })}
      </p>
      <div>
        <Button variant="outline" onClick={onCancel} className="min-h-11">
          {t('cancel')}
        </Button>
      </div>
    </section>
  );
}
