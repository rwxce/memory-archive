import type { ComponentProps } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * A small uppercase label above a title or a section. `tone="accent"` for page eyebrows,
 * `"muted"` for section labels. Renders a `<p>`; pass `as="h2"` when it is the section's heading.
 */
export function Eyebrow({
  as: Tag = 'p',
  tone = 'accent',
  className,
  ...props
}: { as?: 'p' | 'h2' | 'h3' | 'span'; tone?: 'accent' | 'muted' } & ComponentProps<'p'>) {
  return (
    <Tag
      className={cn('text-xs font-semibold tracking-[0.14em] uppercase', tone === 'accent' ? 'text-ac-tx' : 'text-mu', className)}
      {...props}
    />
  );
}
