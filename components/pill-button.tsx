import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';

const VARIANTS = { primary: 'default', outlined: 'outline', 'ghost-link': 'link', danger: 'destructive' } as const;
const SIZES = { md: 'default', lg: 'lg' } as const;

/**
 * The design's pill buttons, over the shadcn `Button` (so a button and a link look the same;
 * pass `asChild` with a `<Link>`):
 * - `primary`: solid accent; `outlined`: 1.5 px line; `ghost-link`: accent text, underlined, no fill;
 *   `danger`: for destructive confirmations.
 * - `md` (48 px) or `lg` (56 px, the hero action). Every size is at least 44 px.
 */
export function PillButton({
  variant = 'primary',
  size = 'md',
  ...props
}: { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; asChild?: boolean } & Omit<ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return <Button variant={VARIANTS[variant]} size={SIZES[size]} {...props} />;
}
