import { defineRouting } from 'next-intl/routing';

export const locales = ['en', 'ca', 'es'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

/** Each language named in itself, for the language picker. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  ca: 'Català',
  es: 'Español',
};

export const routing = defineRouting({
  locales,
  defaultLocale,
  // Static export: every page lives under `/<locale>/`; there is no middleware
  // to rewrite unprefixed paths.
  localePrefix: 'always',
});

/**
 * Best UI locale for a browser's preferred languages (`navigator.languages`):
 * the first entry whose primary subtag we support, else the default.
 */
export function pickLocale(preferred: readonly string[] | undefined): Locale {
  for (const tag of preferred ?? []) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    const match = locales.find((l) => l === primary);
    if (match) return match;
  }
  return defaultLocale;
}
