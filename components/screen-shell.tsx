'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { BackPill } from '@/components/back-pill';
import { PillButton } from '@/components/pill-button';
import { Sidebar } from '@/components/sidebar';
import { TabBar } from '@/components/tab-bar';
import { cn } from '@/components/ui/utils';
import { Link, usePathname } from '@/i18n/navigation';
import { isTopLevel } from './nav-items';

/**
 * The chrome around every screen.
 * - Phones and tablets: top-level screens (People, Search, Import, Settings) get the floating tab
 *   bar; a sub-screen passes `back` and gets a back pill instead (`back.label` defaults to "Back").
 * - Desktop (from `lg`): the sidebar on the left for all of them, and the content in a rounded
 *   `sf` panel that fills the rest of the window.
 * The polite status region lives here, in every state of a screen, so a message set while a form
 * closes is announced by a region that was already on screen.
 */
export function Shell({
  children,
  message = '',
  back,
  focused = false,
}: {
  children: ReactNode;
  message?: string;
  back?: { href: string; label?: ReactNode };
  /** A task in progress (the import steps): no tab bar and no footer link, so the screen's own sticky actions sit at the bottom. */
  focused?: boolean;
}) {
  const t = useTranslations('people');
  const topLevel = isTopLevel(usePathname()) && !focused;

  return (
    <div className="lg:flex">
      <Sidebar />
      <div className="min-w-0 flex-1 lg:p-5">
        <main
          data-panel
          className={cn(
            'mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pt-8 sm:px-6 sm:pt-12',
            'lg:bg-sf lg:mx-0 lg:min-h-[calc(100dvh-2.5rem)] lg:max-w-none lg:gap-6 lg:rounded-[32px] lg:p-12',
            // Room under the content for the floating tab bar.
            focused ? 'pb-0 lg:pb-12' : topLevel ? 'pb-32' : 'pb-16',
          )}
        >
          {back && <BackPill href={back.href}>{back.label}</BackPill>}
          <div role="status" aria-live="polite" className="text-muted-foreground text-sm break-words empty:-mb-5 empty:h-0">
            {message}
          </div>
          {children}
          {!focused && (
            <PillButton asChild variant="ghost-link" className="w-fit px-0">
              <Link href="/welcome">{t('about')}</Link>
            </PillButton>
          )}
        </main>
      </div>
      {topLevel && <TabBar />}
    </div>
  );
}

/**
 * The frame of a full-height screen with its own scrolling feed (a conversation, a timeline): a
 * single column on phones, and on desktop the sidebar plus the feed filling the rest of the window.
 */
export function FeedShell({ children }: { children: ReactNode }) {
  return (
    <div className="lg:flex">
      <Sidebar />
      <div className="mx-auto flex h-dvh w-full max-w-3xl min-w-0 flex-col lg:mx-0 lg:max-w-none lg:flex-1">{children}</div>
    </div>
  );
}
