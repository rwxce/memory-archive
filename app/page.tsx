import type { Metadata } from 'next';
import { LocaleRedirect } from '@/components/locale-redirect';
import { THEME_INIT_SCRIPT } from '@/hooks/theme';
import { defaultLocale } from '@/i18n/routing';
import { getTranslations } from 'next-intl/server';
import { shareMetadata } from './og';

// `/` is the link people share. Crawlers don't run the redirect script, so this
// page carries its own preview (in the default language).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: defaultLocale, namespace: 'meta' });
  const title = t('title');
  const description = t('description');
  return { title, description, ...shareMetadata({ locale: defaultLocale, title, description, path: '/' }) };
}

/** `/`: sends the browser to its best UI language (see LocaleRedirect). */
export default function RootPage() {
  return (
    <html lang={defaultLocale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh items-center justify-center p-6">
        <LocaleRedirect />
      </body>
    </html>
  );
}
