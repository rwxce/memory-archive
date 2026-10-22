'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import {
  FieldError,
  normalizeDescription,
  normalizeProfileName,
  normalizeRelationship,
  PROFILE_DESCRIPTION_MAX,
  PROFILE_NAME_MAX,
  PROFILE_RELATIONSHIP_MAX,
} from '@/lib/domain/profile';

export interface ProfileFormValues {
  displayName: string;
  relationship: string;
  description: string;
}

type Field = keyof ProfileFormValues;
type Errors = Partial<Record<Field, string>>;

const inputClass =
  'bg-bg border-input placeholder:text-mu w-full rounded-2xl border px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive';

/**
 * Create / edit form for a person. Text is checked with the same rules the
 * library applies (trimmed, never cut short), so what is rejected is explained
 * next to the field. A failed save keeps what was typed.
 */
export function ProfileForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<ProfileFormValues>;
  /** Receives trimmed values; reject to show "could not be saved". */
  onSubmit: (values: ProfileFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('people.form');
  const id = useId();
  const refs = useRef<Partial<Record<Field, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const [values, setValues] = useState<ProfileFormValues>({
    displayName: initial?.displayName ?? '',
    relationship: initial?.relationship ?? '',
    description: initial?.description ?? '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  // A ref as well: a second submit can arrive before React re-renders with `saving`.
  const savingNow = useRef(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const editing = initial !== undefined;

  useEffect(() => refs.current.displayName?.focus(), []);

  const set = (field: Field) => (value: string) => setValues((v) => ({ ...v, [field]: value }));

  /** Trimmed values when everything is valid; otherwise explains each problem and focuses the first one. */
  const validate = (): ProfileFormValues | undefined => {
    const found: Errors = {};
    const check = <T,>(name: Field, normalize: (v: string) => T, tooLong: string, max: number): T | undefined => {
      try {
        return normalize(values[name]);
      } catch (error) {
        if (!(error instanceof FieldError)) throw error;
        if (name === 'displayName' && /empty/.test(error.message)) found[name] = t('nameRequired');
        else if (/at most/.test(error.message)) found[name] = t(tooLong, { max });
        else found[name] = t('invalidText');
        return undefined;
      }
    };
    const displayName = check('displayName', normalizeProfileName, 'nameTooLong', PROFILE_NAME_MAX);
    const relationship = check('relationship', normalizeRelationship, 'relationshipTooLong', PROFILE_RELATIONSHIP_MAX);
    const description = check('description', normalizeDescription, 'descriptionTooLong', PROFILE_DESCRIPTION_MAX);
    setErrors(found);
    const firstInvalid = (['displayName', 'relationship', 'description'] as const).find((f) => found[f]);
    if (firstInvalid) {
      refs.current[firstInvalid]?.focus();
      return undefined;
    }
    return { displayName: displayName!, relationship: relationship!, description: description! };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingNow.current) return;
    const clean = validate();
    if (!clean) return;
    savingNow.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await onSubmit(clean);
    } catch {
      setFailed(true);
      savingNow.current = false;
      setSaving(false);
      // Keep focus inside the form (and on a control that can retry).
      saveRef.current?.focus();
    }
  };

  const field = (name: Field, label: string, hint?: string) => {
    const inputId = `${id}-${name}`;
    const describedBy = [errors[name] && `${inputId}-error`, hint && `${inputId}-hint`].filter(Boolean).join(' ') || undefined;
    const common = {
      id: inputId,
      value: values[name],
      onChange: (e: { target: { value: string } }) => set(name)(e.target.value),
      'aria-invalid': errors[name] ? true : undefined,
      'aria-describedby': describedBy,
    };
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-[15px] font-semibold break-words">
          {label}
        </label>
        {name === 'description' ? (
          <textarea {...common} ref={(el) => void (refs.current[name] = el)} rows={4} className={cn(inputClass, 'py-3')} />
        ) : (
          <input
            {...common}
            ref={(el) => void (refs.current[name] = el)}
            type="text"
            autoComplete="off"
            aria-required={name === 'displayName' || undefined}
            className={cn(inputClass, 'h-12')}
          />
        )}
        {hint && (
          <p id={`${inputId}-hint`} className="text-mu text-sm">
            {hint}
          </p>
        )}
        <p id={`${inputId}-error`} role="alert" className="text-destructive min-h-0 text-sm break-words empty:hidden">
          {errors[name]}
        </p>
      </div>
    );
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        // Not while an input method is composing (Escape cancels the composition), nor if something already handled it.
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented && !savingNow.current) onCancel();
      }}
      noValidate
      className="bg-sf flex min-w-0 flex-col gap-5 rounded-3xl p-5 sm:p-6 lg:in-data-panel:bg-bg"
    >
      {field('displayName', t('name'))}
      {field('relationship', t('relationship'), t('relationshipHint'))}
      {field('description', t('description'), t('descriptionHint'))}
      <p role="alert" className="text-destructive text-sm break-words empty:hidden">
        {failed ? t('saveFailed') : ''}
      </p>
      {/* Same order on screen and for Tab: Cancel, then the main action. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        {/* aria-disabled, not disabled: a busy button keeps focus. */}
        <Button
          type="button"
          variant="outline"
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          aria-disabled={saving || undefined}
          onClick={() => {
            if (!savingNow.current) onCancel();
          }}
        >
          {t('cancel')}
        </Button>
        <Button ref={saveRef} type="submit" className="aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={saving || undefined}>
          {editing ? t('save') : t('create')}
        </Button>
      </div>
    </form>
  );
}
