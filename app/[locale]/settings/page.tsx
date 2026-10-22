import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { SettingsScreen } from '@/components/settings-screen';

export default function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <SettingsScreen />;
}
