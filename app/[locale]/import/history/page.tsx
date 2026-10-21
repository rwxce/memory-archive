import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { ImportHistoryScreen } from '@/components/import-history-screen';

// An optional filter is chosen by `?person=`: a static export cannot have a route per id.
export default function ImportHistoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <ImportHistoryScreen />
    </Suspense>
  );
}
