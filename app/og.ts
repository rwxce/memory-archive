import type { Metadata } from 'next';
import { defaultLocale, locales, type Locale } from '@/i18n/routing';

// Link previews: what chat apps and social networks show when someone shares a
// link to the app. Static 1200×630 cards per locale in public/og/, made by
// `pnpm og` (scripts/generate-og-cards.mjs). Crawlers fetch them; the app never
// shows them, so the service worker doesn't precache them.

/** Bump after regenerating the cards so link-preview caches fetch them again. */
export const OG_VERSION = 1;

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * Origin the release is served from (`https://rwxce.github.io` on Pages, set in
 * .github/workflows/pages.yml). Crawlers need absolute image URLs. Local builds
 * fall back to `pnpm preview`.
 */
export const SITE_URL = new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:4173');

const OG_LOCALE: Record<Locale, string> = { en: 'en_US', ca: 'ca_ES', es: 'es_ES' };

/** `locale` arrives as a raw route param: anything unknown gets the default card. */
function knownLocale(locale: string): Locale {
  return (locales as readonly string[]).includes(locale) ? (locale as Locale) : defaultLocale;
}

export function ogImage(locale: string, alt: string) {
  return { url: `${basePath}/og/${knownLocale(locale)}.png?v=${OG_VERSION}`, width: 1200, height: 630, alt };
}

/** Open Graph + Twitter card metadata for a page in `locale`. */
export function shareMetadata({
  locale,
  title,
  description,
  path = '',
}: {
  locale: string;
  title: string;
  description: string;
  /** Page path below the base path, e.g. `/ca/`. */
  path?: string;
}): Metadata {
  const image = ogImage(locale, title);
  return {
    metadataBase: SITE_URL,
    openGraph: {
      type: 'website',
      siteName: title,
      title,
      description,
      url: `${basePath}${path}`,
      locale: OG_LOCALE[knownLocale(locale)],
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image.url] },
  };
}
