'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-header';
import { Link } from '@/i18n/navigation';

/**
 * Same top spacing as the Welcome, so nothing jumps between them. The polite
 * status region lives here, in every state of a screen, so a message set while
 * a form closes is announced by a region that was already on screen.
 */
export function Shell({ children, message = '' }: { children: ReactNode; message?: string }) {
  const t = useTranslations('people');
  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-20">
        <div role="status" aria-live="polite" className="text-muted-foreground min-h-5 text-sm break-words">
          {message}
        </div>
        {children}
        <Link
          href="/welcome"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-md text-sm underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('about')}
        </Link>
      </main>
    </>
  );
}
