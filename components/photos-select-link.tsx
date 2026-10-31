'use client';

import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { usePhotoCounts } from '@/hooks/use-photo-counts';
import { Link } from '@/i18n/navigation';

/** The way on from adding pictures to giving them to people: how many are still assigned to nobody. Absent while the collection is empty. */
export function PhotosSelectLink({ version }: { version: unknown }) {
  const t = useTranslations('photos.selectLink');
  const counts = usePhotoCounts(version);
  if (!counts || counts.pictures === 0) return null;
  return (
    <SectionCard className="gap-3 p-[18px]" aria-labelledby="photos-select-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="photos-select-title" tone="muted" className="tracking-widest">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed" data-testid="photos-unassigned">
          {t('body', { count: counts.unassigned })}
        </p>
      </div>
      <div>
        <PillButton asChild variant="outlined">
          <Link href="/photos/select">{t('open')}</Link>
        </PillButton>
      </div>
    </SectionCard>
  );
}
