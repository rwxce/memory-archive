import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ServiceWorkerRegistration } from '@/components/service-worker-registration';
import { ThemeSync } from '@/components/theme-sync';
import { THEME_INIT_SCRIPT } from '@/hooks/theme';
import { LibraryProvider } from '@/hooks/use-library';
import { routing } from '@/i18n/routing';

type Params = { params: Promise<{ locale: string }> };

// One static copy of every page per locale: /en/, /ca/, /es/.
export const dynamicParams = false;
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: t('title'),
    description: t('description'),
    applicationName: t('title'),
    appleWebApp: { capable: true, title: t('title'), statusBarStyle: 'default' },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1b22' },
  ],
};

export default async function LocaleLayout({ children, params }: Params & { children: ReactNode }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <ThemeSync />
        <ServiceWorkerRegistration />
        <NextIntlClientProvider>
          <LibraryProvider>{children}</LibraryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
