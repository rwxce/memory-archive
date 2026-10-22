'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Loader } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { NOTE_MAX } from '@/lib/domain/profile';
import type { NoteController } from '@/hooks/use-note';
import { formatWhen } from './format';

/** The remaining-characters counter appears only this close to the limit. */
const COUNTER_FROM = 500;
const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

type Phase = 'edit' | 'saving' | 'delete' | 'discard';
type Problem = '' | 'invalid' | 'save' | 'delete';

export interface NoteEditorProps {
  /** The note on one target, from `useNote`. */
  note: NoteController;
  /** Visible label of the text field ("Note about this message"). */
  label: string;
  autoFocus?: boolean;
  /** Text typed earlier and not saved, to pick up again (a row that was scrolled away and back). */
  initialDraft?: string;
  /** The unsaved text changed (`undefined`: nothing unsaved any more). */
  onDraftChange?: (draft: string | undefined) => void;
  /** Present when the editor can be closed; pressing Close or Escape asks first if there is unsaved text. */
  onClose?: () => void;
}

/**
 * Edits the one text note on a person, a conversation or a message. The note's text is untrusted and
 * only ever shown in a text field, line breaks kept. Save stores it (Ctrl or Cmd with Enter does too);
 * saving an empty text, or pressing Delete, asks first. Closing or cancelling with unsaved text asks
 * first. A failed write keeps the text in the field and says nothing was lost.
 */
export function NoteEditor({ note, label, autoFocus, initialDraft, onDraftChange, onClose }: NoteEditorProps) {
  const t = useTranslations('notes');
  const locale = useLocale();
  const fieldId = useId();
  const hintId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const [phase, setPhase] = useState<Phase>('edit');
  const [problem, setProblem] = useState<Problem>('');
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  const { state } = note;
  const stored = state.status === 'ready' ? state.note : null;
  const base = stored?.body ?? '';
  const text = draft ?? base;
  const dirty = draft !== undefined && draft !== base;
  const ready = state.status === 'ready';

  useEffect(() => {
    if (ready && autoFocus) field.current?.focus();
  }, [ready, autoFocus]);
  useEffect(() => {
    if (phase === 'delete' || phase === 'discard') confirmButton.current?.focus();
  }, [phase]);

  const edit = (value: string) => {
    setDraft(value);
    setProblem('');
    setNotice('');
    onDraftChange?.(value === base ? undefined : value);
  };
  const back = () => {
    setPhase('edit');
    field.current?.focus();
  };

  const run = async (body: string, deleting: boolean) => {
    if (running.current) return;
    running.current = true;
    setPhase('saving');
    setProblem('');
    setNotice('');
    const result = await note.save(body);
    running.current = false;
    if (result.status === 'saved') {
      setDraft(undefined);
      onDraftChange?.(undefined);
      setNotice(result.note ? t('saved') : t('deleted'));
    } else {
      setProblem(result.status === 'invalid' ? 'invalid' : deleting ? 'delete' : 'save');
    }
    setPhase('edit');
    setTimeout(() => field.current?.focus());
  };

  const submit = () => {
    if (!ready || running.current || !dirty) return;
    if (text.trim() === '') {
      // Saving nothing removes the note, so say so first.
      if (stored) setPhase('delete');
      return;
    }
    void run(text, false);
  };
  const close = () => {
    if (dirty) setPhase('discard');
    else onClose?.();
  };
  const discard = () => {
    setDraft(undefined);
    onDraftChange?.(undefined);
    setProblem('');
    setPhase('edit');
    onClose?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && onClose) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
        {t('loading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">{t('loadFailed')}</span>
        <Button type="button" variant="outline" onClick={note.retry}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const busy = phase === 'saving';
  const remaining = NOTE_MAX - text.length;
  const saved = stored && !dirty ? formatWhen(stored.updatedAt, locale) : null;
  const problemText = problem === 'invalid' ? t('invalid', { max: NOTE_MAX }) : problem === 'save' ? t('saveFailed') : problem === 'delete' ? t('deleteFailed') : '';

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        ref={field}
        id={fieldId}
        dir="auto"
        rows={4}
        maxLength={NOTE_MAX}
        value={text}
        readOnly={busy}
        aria-invalid={problem === 'invalid' || undefined}
        aria-describedby={hintId}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={onKeyDown}
        className="bg-background border-input aria-invalid:border-destructive min-h-24 w-full resize-y rounded-md border px-3 py-2 text-base leading-relaxed whitespace-pre-wrap shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div id={hintId} className="flex min-h-5 flex-col gap-1 text-sm break-words">
        {problemText && (
          <p role="alert" className="text-destructive">
            {problemText}
          </p>
        )}
        {remaining <= COUNTER_FROM && (
          <p role="status" className={remaining <= 0 ? 'text-destructive' : 'text-muted-foreground'}>
            {t('remaining', { count: remaining })}
          </p>
        )}
        {saved && (
          <p className="text-muted-foreground">
            {t('savedAt', { relative: saved.relative, absolute: saved.absolute })}
          </p>
        )}
        <p role="status" className="text-muted-foreground empty:hidden">
          {notice}
        </p>
      </div>

      {phase === 'delete' || phase === 'discard' ? (
        <div role="group" aria-label={phase === 'delete' ? t('deleteTitle') : t('discardTitle')} className="bg-muted/60 flex flex-col gap-3 rounded-lg p-3">
          <p className="text-sm leading-relaxed">{phase === 'delete' ? t('deleteBody') : t('discardBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmButton} type="button" variant="destructive" onClick={() => (phase === 'delete' ? void run('', true) : discard())}>
              {phase === 'delete' ? t('deleteConfirm') : t('discardConfirm')}
            </Button>
            <Button type="button" variant="outline" onClick={back}>
              {phase === 'delete' ? t('deleteKeep') : t('discardKeep')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" aria-disabled={busy || !dirty || undefined} className={busyClass} onClick={submit}>
            {busy && <Loader className="motion-safe:animate-spin" aria-hidden />}
            {busy ? t('saving') : t('save')}
          </Button>
          {(onClose || dirty) && (
            <Button type="button" variant="outline" aria-disabled={busy || undefined} className={busyClass} onClick={() => !busy && close()}>
              {onClose && !dirty ? t('close') : t('cancel')}
            </Button>
          )}
          {stored && (
            <Button type="button" variant="ghost" aria-disabled={busy || undefined} className={busyClass} onClick={() => !busy && setPhase('delete')}>
              {t('delete')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
