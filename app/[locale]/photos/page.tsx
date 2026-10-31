import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PhotosScreen } from '@/components/photos-screen';

export default function PhotosPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <PhotosScreen />;
}
