import { use } from 'react';
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { AppHeader } from '@/components/app-header';
import { LanguagePicker } from '@/components/language-picker';
import { StorageCard } from '@/components/storage-card';
import { ThemePicker } from '@/components/theme-picker';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ARCHIVE_FORMAT_VERSION } from '@/lib/domain/archive';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

export default function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('settings');

  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <h1 className="font-serif text-3xl">{t('title')}</h1>

        <Card>
          <CardHeader>
            <CardTitle>{t('language.title')}</CardTitle>
            <CardDescription>{t('language.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <LanguagePicker />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('theme.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ThemePicker />
          </CardContent>
        </Card>

        <StorageCard />

        <Card>
          <CardHeader>
            <CardTitle>{t('about.title')}</CardTitle>
            <CardDescription>{t('about.privacy')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground flex flex-col gap-1 text-sm">
              <p data-testid="app-version">{t('about.appVersion', { version: APP_VERSION })}</p>
              <p data-testid="format-version">{t('about.formatVersion', { version: ARCHIVE_FORMAT_VERSION })}</p>
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
