'use client';

import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/components/ui/utils';

/**
 * One option of a radio group, as a big touch target (≥ 64 px) with the label, an optional hint,
 * an optional badge and an optional leading tile (an avatar). The native radio does the keyboard
 * work (arrows, Space) and stays in the page, visually hidden; the whole card is its label, and
 * the round indicator on the right shows the choice. Variants: `card` (default), `dashed` (the
 * "add a new one" card, which turns solid when chosen) and `link` (a quiet underlined text option
 * such as "Decide later"). Text is user data: always rendered as text, wrapped when long.
 */
export function Choice({
  id,
  name,
  checked,
  onSelect,
  label,
  hint,
  badge,
  note,
  leading,
  variant = 'card',
}: {
  id?: string;
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  /** Shown under the label while this option is selected (for example "we guessed this one"). */
  note?: ReactNode;
  /** A tile before the text (an avatar, an icon). Decorative. */
  leading?: ReactNode;
  variant?: 'card' | 'dashed' | 'link';
}) {
  const input = <input id={id} type="radio" name={name} checked={checked} onChange={onSelect} className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0" />;

  if (variant === 'link') {
    return (
      <label className="relative flex min-w-0 cursor-pointer flex-col items-start gap-1 has-[:focus-visible]:[&_.link]:ring-[3px]">
        {input}
        <span className="link text-ac-tx ring-ring/50 inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-sm font-medium underline underline-offset-4">
          {checked && <Check className="size-4" aria-hidden />}
          {label}
        </span>
        {checked && hint && <span className="text-mu px-2 text-sm leading-relaxed break-words">{hint}</span>}
      </label>
    );
  }

  return (
    <label
      className={cn(
        'has-[:focus-visible]:ring-ring/50 relative flex min-h-16 min-w-0 cursor-pointer items-center gap-3 rounded-[20px] px-3.5 py-2.5 has-[:focus-visible]:ring-[3px]',
        variant === 'dashed' && !checked
          ? 'border-line border-[1.5px] border-dashed bg-transparent'
          : checked
            ? 'border-ac bg-ac-soft border-2'
            : 'bg-sf border-2 border-transparent lg:in-data-panel:bg-bg',
      )}
    >
      {input}
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-medium break-words">{label}</span>
        {hint && <span className="text-mu text-[13px] leading-snug break-words">{hint}</span>}
        {badge}
        {checked && note}
      </span>
      <span
        aria-hidden
        className={cn('bg-bg size-[22px] shrink-0 rounded-full border-2', checked ? 'border-[7px] border-ac' : 'border-line')}
      />
    </label>
  );
}

/** A group of choices with its question; `error` is announced and linked to the group. */
export function ChoiceGroup({
  legend,
  hint,
  error,
  groupRef,
  children,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string;
  groupRef?: React.Ref<HTMLFieldSetElement>;
  children: ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset ref={groupRef} className="flex min-w-0 flex-col gap-2.5" aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
      <legend className="text-t2 mb-1 text-[15px] leading-snug font-medium break-words">{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="text-t2 -mt-1 mb-1 text-sm leading-relaxed break-words">
          {hint}
        </p>
      )}
      {children}
      <p id={`${id}-error`} role="alert" className="text-destructive text-sm break-words empty:hidden">
        {error}
      </p>
    </fieldset>
  );
}
