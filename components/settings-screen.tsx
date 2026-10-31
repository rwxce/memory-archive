'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { BackPill } from '@/components/back-pill';
import { EraseCard } from '@/components/erase-card';
import { Eyebrow } from '@/components/eyebrow';
import { GitHubLink } from '@/components/github-link';
import { LanguagePicker } from '@/components/language-picker';
import { ReminderSettingsCard } from '@/components/reminder-settings-card';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { settingsRowClass, SettingsRowContent, SettingsRows } from '@/components/settings-row';
import { Shell } from '@/components/screen-shell';
import { StorageCard } from '@/components/storage-card';
import { ThemePicker } from '@/components/theme-picker';
import { useLibrary } from '@/hooks/use-library';
import { Link } from '@/i18n/navigation';
import { localeNames, type Locale } from '@/i18n/routing';
import { ARCHIVE_FORMAT_VERSION } from '@/lib/domain/archive';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

/**
 * Settings: space, appearance, then rows for language (drills into a small language view in the
 * same screen), import history and Backup and restore (its own screen); the erase card; the footer
 * with the privacy note and versions. The library opens here because the space split needs it.
 */
export function SettingsScreen() {
  const t = useTranslations('settings');
  const locale = useLocale() as Locale;
  useLibrary();
  const [view, setView] = useState<'main' | 'language'>('main');
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Moving between the two views moves focus to the new view's title (not on first render).
  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [view]);

  if (view === 'language') {
    return (
      <Shell>
        <BackPill onClick={() => setView('main')}>{t('title')}</BackPill>
        <div className="flex flex-col gap-1.5">
          <PageTitle ref={heading} tabIndex={-1}>
            {t('language.title')}
          </PageTitle>
          <p className="text-t2 leading-relaxed">{t('language.description')}</p>
        </div>
        <LanguagePicker />
      </Shell>
    );
  }

  return (
    <Shell>
      <PageTitle ref={heading} tabIndex={-1}>
        {t('title')}
      </PageTitle>

      <StorageCard />

      <SectionCard className="gap-3 p-[18px]" aria-labelledby="theme-title">
        <Eyebrow as="h2" id="theme-title" tone="muted" className="tracking-widest">
          {t('theme.title')}
        </Eyebrow>
        <ThemePicker />
      </SectionCard>

      <SettingsRows>
        <button type="button" onClick={() => setView('language')} className={settingsRowClass}>
          <SettingsRowContent title={t('language.title')} hint={t('language.description')} value={localeNames[locale]} />
        </button>
        <Link href="/import/history" className={settingsRowClass}>
          <SettingsRowContent title={t('history.title')} hint={t('history.description')} />
        </Link>
        <Link href="/backup" className={settingsRowClass}>
          <SettingsRowContent title={t('backup.title')} hint={t('backup.description')} />
        </Link>
        <Link href="/sync" className={settingsRowClass}>
          <SettingsRowContent title={t('sync.title')} hint={t('sync.description')} />
        </Link>
      </SettingsRows>

      <ReminderSettingsCard />

      <EraseCard />

      <div className="text-mu flex flex-col gap-1 px-1 text-xs leading-relaxed">
        <p>{t('about.privacy')}</p>
        <p data-testid="app-version">{t('about.appVersion', { version: APP_VERSION })}</p>
        <p data-testid="format-version">{t('about.formatVersion', { version: ARCHIVE_FORMAT_VERSION })}</p>
        <GitHubLink className="text-ac-tx self-start text-sm font-medium underline-offset-4 hover:underline" />
      </div>
    </Shell>
  );
}
