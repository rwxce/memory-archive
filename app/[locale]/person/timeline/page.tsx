import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PersonTimelineScreen } from '@/components/person-timeline-screen';

// The person is chosen by `?id=` (and `?date=`): a static export cannot have a route per id.
export default function PersonTimelinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <PersonTimelineScreen />
    </Suspense>
  );
}
