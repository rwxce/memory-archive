import type { ComponentProps } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * A toggle chip for filters (`aria-pressed`), 44 px high. Controlled: `pressed` plus
 * `onPressedChange(next)`.
 */
export function FilterChip({
  pressed,
  onPressedChange,
  className,
  onClick,
  ...props
}: { pressed: boolean; onPressedChange: (next: boolean) => void } & Omit<ComponentProps<'button'>, 'aria-pressed'>) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPressedChange(!pressed);
      }}
      className={cn(
        'focus-visible:ring-ring/50 inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-[3px] [&_svg]:size-4',
        pressed ? 'bg-ac text-ac-ink' : 'bg-sf2 text-t2 hover:bg-line',
        className,
      )}
      {...props}
    />
  );
}
