import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { BackupScreen } from '@/components/backup-screen';

export default function BackupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  // The export card reads `?person=` from the URL, which a static export resolves on the client.
  return (
    <Suspense fallback={null}>
      <BackupScreen />
    </Suspense>
  );
}
