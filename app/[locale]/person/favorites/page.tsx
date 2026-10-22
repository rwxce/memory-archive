import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PersonFavoritesScreen } from '@/components/person-favorites-screen';

// The person is chosen by `?id=`: a static export cannot have a route per id.
export default function PersonFavoritesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <PersonFavoritesScreen />
    </Suspense>
  );
}
