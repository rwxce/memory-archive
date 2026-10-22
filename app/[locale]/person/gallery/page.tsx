import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PersonGalleryScreen } from '@/components/person-gallery-screen';

// The person is chosen by `?id=`: a static export cannot have a route per id.
export default function PersonGalleryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <PersonGalleryScreen />
    </Suspense>
  );
}
