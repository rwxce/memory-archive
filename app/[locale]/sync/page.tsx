import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { SyncScreen } from '@/components/sync-screen';

export default function SyncPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <SyncScreen />;
}
