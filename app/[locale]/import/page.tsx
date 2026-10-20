import { use } from 'react';
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { AppHeader } from '@/components/app-header';
import { SharedFiles } from '@/components/shared-files';

/** Where the share sheet lands (via the service worker). Phase 4 turns it into the import wizard. */
export default function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('import');

  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <h1 className="font-serif text-3xl">{t('title')}</h1>
        <SharedFiles />
      </main>
    </>
  );
}
