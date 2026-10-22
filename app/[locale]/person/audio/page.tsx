import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PersonAudioScreen } from '@/components/person-audio-screen';

// The person is chosen by `?id=`: a static export cannot have a route per id.
export default function PersonAudioPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <PersonAudioScreen />
    </Suspense>
  );
}
