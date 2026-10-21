import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PeopleScreen } from '@/components/people-screen';

export default function PeoplePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <PeopleScreen />;
}
