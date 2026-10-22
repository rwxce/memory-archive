import { use } from 'react';
import { CloudOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { PillButton } from '@/components/pill-button';
import { Link } from '@/i18n/navigation';

/** Served by the service worker for a page that was never saved on this device. */
export default function OfflinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('offline');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-start justify-center gap-5 px-5 py-10 sm:px-6">
      <span aria-hidden className="bg-ac-soft text-ac-tx flex size-14 items-center justify-center rounded-[18px]">
        <CloudOff className="size-7" />
      </span>
      <h1 className="font-display text-display text-balance">{t('title')}</h1>
      <p className="text-t2 text-lg leading-relaxed">{t('body')}</p>
      <PillButton asChild size="lg">
        <Link href="/">{t('home')}</Link>
      </PillButton>
    </main>
  );
}
