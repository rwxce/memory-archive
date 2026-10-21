import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PeopleScreen } from '@/components/people-screen';
import { Welcome } from '@/components/welcome';

/**
 * Home: the People screen once the library has anyone in it; the welcome
 * while it is empty. The switch happens on the device (the export is static
 * and cannot know what the library holds).
 */
export default function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <PeopleScreen whenNoProfiles={<Welcome />} />;
}
