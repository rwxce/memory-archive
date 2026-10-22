import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { ImportScreen } from '@/components/import-screen';

/** The import wizard. The share target (the service worker) lands here with the files it received. */
export default function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <ImportScreen />;
}
