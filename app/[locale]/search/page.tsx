import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { SearchScreen } from '@/components/search-screen';

// The scope is chosen by `?person=` or `?conversation=` and the first query by `?q=`: a static
// export cannot have a route per id.
export default function SearchPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <SearchScreen />
    </Suspense>
  );
}
