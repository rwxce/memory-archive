'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link, usePathname } from '@/i18n/navigation';
import { locales, localeNames } from '@/i18n/routing';

/** Links to the current page in each UI language (each name in its own language). */
export function LanguagePicker() {
  const t = useTranslations('settings.language');
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={t('title')} className="grid gap-2 sm:grid-cols-3">
      {locales.map((locale) => {
        const selected = locale === current;
        return (
          <Button
            key={locale}
            asChild
            variant={selected ? 'secondary' : 'outline'}
            className={selected ? 'ring-ring/60 ring-2' : undefined}
          >
            <Link href={pathname} locale={locale} lang={locale} aria-current={selected ? 'page' : undefined}>
              {localeNames[locale]}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
