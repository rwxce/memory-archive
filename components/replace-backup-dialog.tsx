'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExistingPasswordField } from '@/components/backup-password';
import { PillButton } from '@/components/pill-button';
import type { ArchiveUsage } from '@/lib/usecases/archive-health';

/**
 * Asks before a backup replaces the whole archive. A native modal `<dialog>`: focus is trapped and
 * handed back by the browser, Escape cancels. It says in plain words what is replaced (with the
 * counts when they are known), that a safety copy is downloaded first, and that the person should
 * keep it (and that the safety copy itself is not password-protected). Nothing happens until the explicit
 * confirm button; Cancel has the initial focus. `file` is the backup the person picked (`null` = closed).
 * When the backup is protected (`encrypted`) the dialog also asks for its password; after a wrong one
 * (`wrong`) the caller reopens it with the same file, so only the password is typed again. The typed password
 * lives in the dialog's content, which is gone when it closes.
 */
export function ReplaceBackupDialog({
  file,
  counts,
  encrypted = false,
  wrong = false,
  onConfirm,
  onCancel,
}: {
  file: File | null;
  counts: ArchiveUsage['counts'] | undefined;
  encrypted?: boolean;
  wrong?: boolean;
  onConfirm: (password?: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('backup.replace');
  const tu = useTranslations('backup.usage');
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const confirmed = useRef(false);
  const open = file !== null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      confirmed.current = false;
      element.showModal();
      // Explicit, not `autoFocus`: the safe choice has the focus whatever the browser does on showModal.
      // A protected backup needs its password first, so the field takes it then.
      (passwordInput.current ?? cancelButton.current)?.focus();
    }
    if (!open && element.open) {
      element.close();
      setPassword('');
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="replace-title"
      aria-describedby="replace-body"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="bg-bg text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl p-6 shadow-soft backdrop:bg-black/50"
    >
      {open && (
        <div className="flex flex-col gap-4">
          <h2 id="replace-title" className="font-display text-headline">
            {t('title')}
          </h2>
          <div id="replace-body" className="flex flex-col gap-3 text-sm leading-relaxed">
            <p>{t('body')}</p>
            {counts && (
              <div className="flex flex-col gap-1">
                <p>{t('countsIntro')}</p>
                <ul className="list-disc pl-5" data-testid="replace-counts">
                  <li>{tu('people', { count: counts.profiles })}</li>
                  <li>{tu('conversations', { count: counts.conversations })}</li>
                  <li>{tu('messages', { count: counts.messages })}</li>
                  <li>{tu('files', { count: counts.mediaFiles })}</li>
                </ul>
              </div>
            )}
            <p className="font-medium">{t('safety')}</p>
            <p>{t('safetyPlain')}</p>
            <p className="text-t2 break-words">{t('file', { fileName: file.name })}</p>
            {encrypted && (
              <form onSubmit={(event) => event.preventDefault()} noValidate className="flex flex-col gap-2">
                <p>{t('encrypted')}</p>
                <ExistingPasswordField value={password} onChange={setPassword} wrong={wrong} inputRef={passwordInput} />
              </form>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <PillButton ref={cancelButton} variant="outlined" onClick={onCancel}>
              {t('cancel')}
            </PillButton>
            <PillButton
              variant="danger"
              onClick={() => {
                if (confirmed.current) return;
                if (encrypted && password.length === 0) {
                  passwordInput.current?.focus();
                  return;
                }
                confirmed.current = true;
                const chosen = encrypted ? password : undefined;
                setPassword('');
                onConfirm(chosen);
              }}
            >
              {t('confirm')}
            </PillButton>
          </div>
        </div>
      )}
    </dialog>
  );
}
