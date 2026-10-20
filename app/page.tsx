import type { Metadata } from 'next';
import { LocaleRedirect } from '@/components/locale-redirect';
import { THEME_INIT_SCRIPT } from '@/hooks/theme';
import { defaultLocale } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Memory Archive',
};

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
