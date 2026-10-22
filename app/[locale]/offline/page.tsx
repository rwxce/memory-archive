import { use } from 'react';
import { CloudOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

/** Served by the service worker for a page that was never saved on this device. */
export default function OfflinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('offline');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-start justify-center gap-5 px-4 sm:px-6">
      <CloudOff className="text-primary size-8" aria-hidden />
      <h1 className="font-serif text-3xl">{t('title')}</h1>
      <p className="text-muted-foreground text-lg leading-relaxed">{t('body')}</p>
      <Button asChild>
        <Link href="/">{t('home')}</Link>
      </Button>
    </main>
  );
}
