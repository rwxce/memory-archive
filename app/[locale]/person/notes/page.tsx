import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PersonNotesScreen } from '@/components/person-notes-screen';

// The person is chosen by `?id=`: a static export cannot have a route per id.
export default function PersonNotesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <PersonNotesScreen />
    </Suspense>
  );
}
