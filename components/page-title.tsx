import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * The serif title of a screen. `accent` is an optional italic coral tail ("Keep their words
 * <close>"). `ref` and `tabIndex` pass through so a screen can move focus to its heading.
 * Use `as="h2"` when the page already has an h1.
 */
export function PageTitle({
  as: Tag = 'h1',
  accent,
  children,
  className,
  ...props
}: { as?: 'h1' | 'h2'; accent?: ReactNode } & ComponentProps<'h1'>) {
  return (
    <Tag className={cn('font-display text-display min-w-0 text-balance [overflow-wrap:anywhere] outline-none', className)} {...props}>
      {children}
      {accent !== undefined && accent !== '' && (
        <>
          {' '}
          <span className="text-co italic">{accent}</span>
        </>
      )}
    </Tag>
  );
}
