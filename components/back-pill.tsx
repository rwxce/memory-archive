'use client';

import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/components/ui/utils';

const pillClass =
  'bg-sf2 text-foreground hover:bg-line focus-visible:ring-ring/50 inline-flex min-h-11 w-fit max-w-full items-center gap-1 rounded-full py-2 ps-3 pe-4 text-sm font-medium outline-none focus-visible:ring-[3px]';

/**
 * The way back on a sub-screen: a 44 px `sf2` pill with a chevron and a label (default "Back").
 * With `href` it is a link; with `onClick` instead it is a button (for a view inside a screen).
 */
export function BackPill({
  href,
  onClick,
  children,
  className,
}: { children?: ReactNode; className?: string } & ({ href: string; onClick?: never } | { href?: never; onClick: () => void })) {
  const t = useTranslations('nav');
  const content = (
    <>
      <ChevronLeft className="size-5 shrink-0 rtl:rotate-180" aria-hidden />
      <span className="truncate">{children ?? t('back')}</span>
    </>
  );
  if (href !== undefined) {
    return (
      <Link href={href} className={cn(pillClass, className)}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(pillClass, className)}>
      {content}
    </button>
  );
}
