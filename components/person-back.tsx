'use client';

import { useTranslations } from 'next-intl';

/**
 * The `back` of a person's sub-screen (Gallery, Audio, Timeline...): the pill shows the person's
 * name, as in the design; "Back to" is read out to assistive technology only.
 */
export function usePersonBack(person: { id: string; displayName: string }) {
  const t = useTranslations('subpage');
  return {
    href: `/person?id=${encodeURIComponent(person.id)}`,
    label: (
      <>
        <span className="sr-only">{t('backTo')} </span>
        <span dir="auto">{person.displayName}</span>
      </>
    ),
  };
}

/** The back target when the person could not be read: the People list. */
export function usePeopleBack() {
  const tp = useTranslations('person');
  return { href: '/people', label: tp('back') };
}
