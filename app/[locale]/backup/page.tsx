import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { BackupScreen } from '@/components/backup-screen';

export default function BackupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <BackupScreen />;
}
