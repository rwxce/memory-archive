import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';

/** Two plain facts that hold for every import, always on screen. */
export function PhotosNotes() {
  const t = useTranslations('photos.notes');
  return (
    <SectionCard tone="soft" className="gap-2 p-[18px]" aria-labelledby="photos-notes-title">
      <Eyebrow as="h2" id="photos-notes-title" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      <ul className="text-t2 flex list-disc flex-col gap-1.5 pl-5 leading-relaxed">
        <li>{t('unassigned')}</li>
        <li>{t('estimate')}</li>
      </ul>
    </SectionCard>
  );
}
