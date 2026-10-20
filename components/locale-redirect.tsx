'use client';

import { useEffect } from 'react';
import { locales, localeNames, pickLocale } from '@/i18n/routing';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Pages `/?to=<name>` may lead to (the share target uses `to=import`). */
const TARGETS: Record<string, string> = { import: 'import/' };

/** `/<locale>/<target>` for `?to=...`, keeping only known targets and query keys. */
export function redirectPath(locale: string, search: string): string {
  const params = new URLSearchParams(search);
  const target = TARGETS[params.get('to') ?? ''];
  if (!target) return `${basePath}/${locale}/`;
  const received = params.get('received');
  const query = received && /^\d{1,3}$/.test(received) ? `?received=${received}` : '';
  return `${basePath}/${locale}/${target}${query}`;
}

/**
 * `/` has no language. Static export has no middleware, so the browser picks:
 * the first of `navigator.languages` we support, else English. The links stay
 * visible as a fallback (no JavaScript, or a slow device).
 */
export function LocaleRedirect() {
  useEffect(() => {
    const locale = pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
    window.location.replace(redirectPath(locale, window.location.search));
  }, []);

  return (
    <ul className="flex flex-col items-center gap-3">
      {locales.map((locale) => (
        <li key={locale}>
          <a
            href={`${basePath}/${locale}/`}
            lang={locale}
            className="inline-flex min-h-11 items-center px-3 underline-offset-4 hover:underline"
          >
            {localeNames[locale]}
          </a>
        </li>
      ))}
    </ul>
  );
}
