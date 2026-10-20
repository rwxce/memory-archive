import { getTranslations } from 'next-intl/server';
import { THEME_INIT_SCRIPT } from '@/hooks/theme';
import { defaultLocale } from '@/i18n/routing';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Exported as `out/404.html`. Static hosts serve it for unknown paths, which
// have no locale, so it is written in the default language.
export default async function NotFound() {
  const t = await getTranslations({ locale: defaultLocale, namespace: 'notFound' });
  return (
    <html lang={defaultLocale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-serif text-2xl">{t('title')}</h1>
        <a href={`${basePath}/`} className="inline-flex min-h-11 items-center underline underline-offset-4">
          {t('back')}
        </a>
      </body>
    </html>
  );
}
