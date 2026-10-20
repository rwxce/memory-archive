import { BookHeart, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

/** Top bar: the app name (home) and the way to Settings. */
export function AppHeader() {
  const t = useTranslations();
  return (
    <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-4 sm:px-6 sm:pt-6">
      <Link
        href="/"
        className="flex min-h-11 items-center gap-2 rounded-md font-serif text-lg font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <BookHeart className="size-5 text-primary" aria-hidden />
        {t('meta.title')}
      </Link>
      <Button asChild variant="ghost" size="icon">
        <Link href="/settings" aria-label={t('nav.settings')} title={t('nav.settings')}>
          <Settings className="size-5" aria-hidden />
        </Link>
      </Button>
    </header>
  );
}
