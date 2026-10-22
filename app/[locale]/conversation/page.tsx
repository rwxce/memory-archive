import { Suspense, use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { ConversationScreen } from '@/components/conversation-screen';

// The conversation is chosen by `?id=` (and `?date=`): a static export cannot have a route per id.
export default function ConversationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={null}>
      <ConversationScreen />
    </Suspense>
  );
}
