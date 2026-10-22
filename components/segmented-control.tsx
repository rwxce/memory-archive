'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import { nextRadioIndex } from './radio-keys';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * Two to four exclusive choices as a `radiogroup`. Arrow keys (and Home/End) move the selection
 * as native radios do; only the selected segment is in the tab order. Segments are 44 px high.
 * `label` names the group for assistive technology.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (event: KeyboardEvent, from: number) => {
    const to = nextRadioIndex(event.key, from, options.length, getComputedStyle(event.currentTarget).direction === 'rtl');
    if (to === undefined) return;
    event.preventDefault();
    refs.current[to]?.focus();
    onChange(options[to].value);
  };

  return (
    <div role="radiogroup" aria-label={label} className={cn('bg-sf2 inline-flex w-full gap-1 rounded-full p-1', className)}>
      {options.map((option, index) => {
        const on = index === selected;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'focus-visible:ring-ring/50 min-h-11 flex-1 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-[3px]',
              on ? 'bg-bg text-foreground font-semibold' : 'text-t2 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
