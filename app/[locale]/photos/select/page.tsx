import { use } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { PhotosSelectScreen } from '@/components/photos-select-screen';

export default function PhotosSelectPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return <PhotosSelectScreen />;
}
