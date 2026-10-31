'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';

const inputClass =
  'bg-bg border-input h-12 w-full rounded-2xl border px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive';
// aria-disabled, not disabled: a busy button keeps focus (a disabled one drops it).
const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

/** Why two new passwords cannot be used yet. Nothing is trimmed or changed: the password is exactly what was typed. */
export function passwordProblem(password: string, confirm: string): 'empty' | 'mismatch' | undefined {
  if (password.length === 0) return 'empty';
  return password !== confirm ? 'mismatch' : undefined;
}

/**
 * One password field: a visible label, `type=password` (or plain text while the person chose to see it),
 * no spell-check or auto-capitalisation, and an inline error tied to the field. The browser is told whether
 * it is a new password or the one that opens an existing backup.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  autoComplete,
  error,
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  autoComplete: 'new-password' | 'current-password';
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/** A fixed label with `aria-pressed` (never both a swapped label and a pressed state), pointing at the fields it reveals. */
function ShowToggle({ show, onToggle, controls }: { show: boolean; onToggle: () => void; controls: string[] }) {
  const t = useTranslations('backup.password');
  return (
    <div>
      <PillButton type="button" variant="ghost-link" aria-pressed={show} aria-controls={controls.join(' ')} onClick={onToggle}>
        {controls.length > 1 ? t('showMany') : t('showOne')}
      </PillButton>
    </div>
  );
}

/**
 * "Back up the whole archive" with the optional password. A plain backup is a normal ZIP that anyone holding the
 * file can read, so the card says it is private; the switch adds a password and a confirmation, and says plainly
 * that a forgotten password cannot be recovered. The password lives only in this component and is cleared the
 * moment the backup starts. Mismatch or empty blocks the backup with the error beside the field.
 */
export function BackupMaker({
  disabled,
  onBackup,
  labels,
}: {
  disabled: boolean;
  onBackup: (password: string | undefined) => void;
  /** Other words for the same form (a changes pack): the button and the two notes. They default to the backup's. */
  labels?: { submit: string; privateNote: string; protectNote: string };
}) {
  const t = useTranslations('backup.copy');
  const tp = useTranslations('backup.password');
  const toggleId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const problem = protect ? passwordProblem(password, confirm) : undefined;

  const reset = () => {
    setPassword('');
    setConfirm('');
    setShow(false);
    setTouched(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    if (problem) {
      setTouched(true);
      (problem === 'empty' ? passwordInput : confirmInput).current?.focus();
      return;
    }
    const chosen = protect ? password : undefined;
    reset();
    onBackup(chosen);
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <label htmlFor={toggleId} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] font-medium">
        <input
          id={toggleId}
          type="checkbox"
          checked={protect}
          aria-describedby={`${toggleId}-note`}
          onChange={(event) => {
            setProtect(event.target.checked);
            reset();
          }}
          className="accent-primary focus-visible:ring-ring/50 size-5 shrink-0 outline-none focus-visible:ring-[3px]"
        />
        {t('protect')}
      </label>
      <p id={`${toggleId}-note`} className="text-t2 text-sm leading-relaxed" data-testid="backup-protect-note">
        {protect ? (labels?.protectNote ?? t('protectNote')) : (labels?.privateNote ?? t('privateNote'))}
      </p>
      {protect && (
        <div className="flex flex-col gap-3">
          <PasswordField
            id={passwordId}
            label={tp('label')}
            value={password}
            onChange={setPassword}
            show={show}
            autoComplete="new-password"
            error={touched && problem === 'empty' ? tp('empty') : undefined}
            inputRef={passwordInput}
          />
          <div onBlur={() => confirm !== '' && setTouched(true)} className="contents">
            <PasswordField
              id={confirmId}
              label={tp('confirmLabel')}
              value={confirm}
              onChange={setConfirm}
              show={show}
              autoComplete="new-password"
              error={touched && problem === 'mismatch' ? tp('mismatch') : undefined}
              inputRef={confirmInput}
            />
          </div>
          <ShowToggle show={show} onToggle={() => setShow((value) => !value)} controls={[passwordId, confirmId]} />
        </div>
      )}
      <div>
        <PillButton type="submit" aria-disabled={disabled || undefined} className={busyClass}>
          {labels?.submit ?? t('backup')}
        </PillButton>
      </div>
    </form>
  );
}

/**
 * The password field with its show/hide switch, for opening a protected backup. Used inside the replace dialog and by
 * `PasswordPrompt`. `wrong` marks the field and says so; the caller keeps the person's file so they can try again.
 */
export function ExistingPasswordField({
  value,
  onChange,
  wrong,
  wrongMessage,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  wrong: boolean;
  /** Words for a wrong password that fit the file (a changes pack, not a backup). */
  wrongMessage?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const tp = useTranslations('backup.password');
  const ta = useTranslations('archive.error');
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <PasswordField id={id} label={tp('label')} value={value} onChange={onChange} show={show} autoComplete="current-password" error={wrong ? (wrongMessage ?? ta('wrongPassword')) : undefined} inputRef={inputRef} />
      <ShowToggle show={show} onToggle={() => setShow((current) => !current)} controls={[id]} />
    </div>
  );
}

/**
 * Asks for the password of a protected backup the person just picked, inline in the card. The file stays with the
 * caller, so a wrong password only needs the password typed again, not the file picked again. Takes focus when it
 * appears and again after a wrong password. The typed text is cleared as soon as it is handed over.
 */
export function PasswordPrompt({
  fileName,
  wrong,
  submitLabel,
  onSubmit,
  onCancel,
  labels,
}: {
  fileName: string;
  wrong: boolean;
  submitLabel: string;
  /** Other words for a file that is not a backup (a changes pack). They default to the backup's. */
  labels?: { title: string; body: string; cancel: string; wrong?: string };
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('backup.prompt');
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const headingId = useId();
  useEffect(() => {
    input.current?.focus();
  }, [wrong]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length === 0) {
      input.current?.focus();
      return;
    }
    const chosen = password;
    setPassword('');
    onSubmit(chosen);
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby={headingId} data-testid="password-prompt" className="bg-bg flex flex-col gap-3 rounded-[14px] p-3.5">
      <h3 id={headingId} className="text-[15px] font-semibold">
        {labels?.title ?? t('title')}
      </h3>
      <p className="text-t2 text-sm leading-relaxed break-words">{labels?.body ?? t('body', { fileName })}</p>
      <ExistingPasswordField value={password} onChange={setPassword} wrong={wrong} wrongMessage={labels?.wrong} inputRef={input} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <PillButton type="button" variant="outlined" onClick={onCancel}>
          {labels?.cancel ?? t('cancel')}
        </PillButton>
        <PillButton type="submit">{submitLabel}</PillButton>
      </div>
    </form>
  );
}
