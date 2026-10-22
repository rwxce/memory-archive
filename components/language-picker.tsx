'use client';

import { Check } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/components/ui/utils';
import { Link, usePathname } from '@/i18n/navigation';
import { locales, localeNames } from '@/i18n/routing';

/** Links to the current page in each UI language (each name in its own language), as rows with a check on the current one. */
export function LanguagePicker() {
  const t = useTranslations('settings.language');
  const current = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={t('title')} className="bg-sf flex flex-col overflow-hidden rounded-3xl lg:in-data-panel:bg-bg">
      {locales.map((locale) => {
        const selected = locale === current;
        return (
          <Link
            key={locale}
            href={pathname}
            locale={locale}
            lang={locale}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'border-line focus-visible:ring-ring/50 flex min-h-16 items-center gap-3 border-b px-5 text-[15px] outline-none last:border-b-0 focus-visible:ring-[3px] focus-visible:ring-inset',
              selected ? 'text-ac-tx font-semibold' : 'font-medium',
            )}
          >
            <span className="flex-1">{localeNames[locale]}</span>
            {selected && <Check className="size-5" aria-hidden />}
          </Link>
        );
      })}
    </nav>
  );
}
