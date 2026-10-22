import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { Welcome } from '@/components/welcome';

/** The welcome, always reachable (home only shows it while the library is empty). */
export default function WelcomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <Welcome />;
}
