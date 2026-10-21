'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * One option of a radio group, as a big touch target (≥ 44 px) with the label, an optional hint
 * and an optional badge. The native radio does the keyboard work (arrows, Space); the whole card
 * is its label. Text is user data: always rendered as text, wrapped when long.
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
}) {
  return (
    <label
      className={cn(
        'bg-card flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
        checked && 'border-primary bg-primary/5',
      )}
    >
      <input id={id} type="radio" name={name} checked={checked} onChange={onSelect} className="accent-primary mt-0.5 size-5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium break-words">{label}</span>
        {hint && <span className="text-muted-foreground text-sm leading-relaxed break-words">{hint}</span>}
        {badge}
        {checked && note}
      </span>
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
    <fieldset ref={groupRef} className="flex min-w-0 flex-col gap-3" aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
      <legend className="mb-1 text-lg leading-snug font-semibold break-words">{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground -mt-1 leading-relaxed break-words">
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
