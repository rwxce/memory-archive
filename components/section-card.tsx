import type { ComponentProps } from 'react';
import { cn } from '@/components/ui/utils';

const TONES = {
  /** The neutral card. On the desktop panel (itself `sf`) it turns to the page color, so it still reads as a card. */
  sf: 'bg-sf lg:in-data-panel:bg-bg',
  sf2: 'bg-sf2',
  soft: 'bg-ac-soft',
  mint: 'bg-mint',
  butter: 'bg-butter',
  peach: 'bg-peach',
} as const;

/** A flat rounded card: no border, no shadow, tinted by `tone`. Use `as="ul"`/`"li"` etc. when it is a list item. */
export function SectionCard({
  as: Tag = 'section',
  tone = 'sf',
  className,
  ...props
}: { as?: 'section' | 'div' | 'li' | 'article'; tone?: keyof typeof TONES } & Omit<ComponentProps<'div'>, 'ref'>) {
  const Element = Tag as 'div';
  return <Element className={cn('flex min-w-0 flex-col gap-3 rounded-3xl p-5', TONES[tone], className)} {...props} />;
}
