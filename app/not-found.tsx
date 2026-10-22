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
      <body className="bg-bg text-ink flex min-h-dvh flex-col items-center justify-center gap-5 p-6 text-center">
        <h1 className="font-display text-display text-balance">{t('title')}</h1>
        <a
          href={`${basePath}/`}
          className="bg-ac text-ac-ink focus-visible:ring-ring/50 inline-flex h-12 items-center rounded-full px-6 text-sm font-semibold outline-none focus-visible:ring-[3px]"
        >
          {t('back')}
        </a>
      </body>
    </html>
  );
}
