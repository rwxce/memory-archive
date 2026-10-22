'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/components/ui/utils';
import { activeTab, TABS } from './nav-items';

/**
 * The floating glass bottom bar of the top-level screens on phones and tablets (hidden from `lg`,
 * where the sidebar takes over). The current tab has `aria-current="page"` and a 48x28 soft pill
 * behind its icon. Respects the home-indicator safe area.
 */
export function TabBar() {
  const t = useTranslations('nav');
  const current = activeTab(usePathname());

  return (
    <nav
      aria-label={t('primary')}
      className="bg-glass border-glass-line shadow-soft fixed inset-x-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 mx-auto grid h-17 max-w-xl grid-cols-4 rounded-3xl border px-1.5 backdrop-blur-[20px] backdrop-saturate-[180%] lg:hidden"
    >
      {TABS.map(({ id, href, Icon }) => {
        const on = id === current;
        return (
          <Link
            key={id}
            href={href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 flex min-h-11 flex-col items-center justify-center gap-1 rounded-2xl text-[11px] outline-none focus-visible:ring-[3px]',
              on ? 'text-ac-tx font-semibold' : 'text-glass-tx font-medium',
            )}
          >
            <span className={cn('flex h-7 w-12 items-center justify-center rounded-full', on && 'bg-ac-soft')}>
              <Icon className="size-5" strokeWidth={on ? 1.9 : 1.75} aria-hidden />
            </span>
            {t(`tabs.${id}`)}
          </Link>
        );
      })}
    </nav>
  );
}
