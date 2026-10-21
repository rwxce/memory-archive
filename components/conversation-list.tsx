'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRightLeft, Link2, Pencil, Unlink, UserPlus, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { ConversationActions } from '@/hooks/use-conversation-actions';
import { CONVERSATION_TITLE_MAX, FieldError, normalizeConversationTitle } from '@/lib/domain/profile';
import type { ConversationRow } from '@/lib/usecases/conversations';
import type { People } from '@/lib/usecases/library';
import { formatDateRange, formatNames } from './format';

const inputClass =
  'bg-background border-input w-full rounded-md border px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive';
// aria-disabled, not disabled: a busy button keeps focus (a disabled one drops it).
const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
/** At most this many participant names are spelled out; the rest is a count. */
const NAMES_SHOWN = 3;

type Kind = 'rename' | 'move' | 'link' | 'unlink';
type Panel = { kind: Kind; id: string };

/** Escape closes a panel, unless an input method is composing or something already handled the key. */
const onEscape = (close: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) {
    event.stopPropagation();
    close();
  }
};

/**
 * A list of conversations with what can be done to each: rename, move to
 * another person, also link to another one, unlink. Without `personId` it is
 * the "not assigned yet" list, where the one way forward is to assign.
 *
 * Nothing here copies or edits messages; the copy says so wherever a conversation
 * is filed somewhere else. Group chats are labelled as groups and never as
 * private chats.
 */
export function ConversationList({
  conversations,
  people,
  personId,
  actions,
  announce,
  onGone,
  headingLevel = 'h3',
}: {
  conversations: ConversationRow[];
  people: People;
  /** The person whose page this is; absent for conversations that belong to no one. */
  personId?: string;
  actions: ConversationActions;
  announce: (message: string) => void;
  /** A conversation left this list (moved or unlinked): give focus back to something that is still there. */
  onGone: () => void;
  headingLevel?: 'h2' | 'h3';
}) {
  const t = useTranslations('conversations');
  const locale = useLocale();
  const [panel, setPanel] = useState<Panel>();
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [problem, setProblem] = useState('');
  const everyone = [...people.active, ...people.archived];
  const nameOf = (id: string) => everyone.find((person) => person.id === id)?.displayName ?? '';

  const open = (kind: Kind, id: string) => {
    if (busyNow.current) return;
    setProblem('');
    setPanel({ kind, id });
  };
  /** Closes the panel and gives focus back to the button that opened it, or to `onGone` when the row left. */
  const close = (kind: Kind, id: string) => {
    setPanel(undefined);
    setProblem('');
    setTimeout(() => {
      const button = document.getElementById(`${id}-${kind}`);
      if (button) button.focus();
      else onGone();
    });
  };
  /**
   * Runs one change; true when it was stored. Never two at once. A failure is
   * explained by the panel's own alert (rename and pick forms have one); only
   * the unlink confirmation, which has no form, gets `problem`.
   */
  const run = async (row: ConversationRow, kind: Kind, work: () => Promise<unknown>, message: string): Promise<boolean> => {
    if (busyNow.current) return false;
    busyNow.current = true;
    setBusy(true);
    setProblem('');
    try {
      await work();
      announce(message);
      return true;
    } catch {
      if (kind === 'unlink') setProblem(t('actionFailed', { title: row.title }));
      return false;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  };

  const Title = headingLevel;
  const ariaBusy = busy || undefined;
  const unlessBusy = (action: () => void) => () => {
    if (!busy) action();
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3" aria-label={t('listLabel')}>
        {conversations.map((row) => {
          const here = panel?.id === row.id ? panel.kind : undefined;
          const shared = row.isGroup || row.profileIds.length > 1;
          const others = row.profileIds.filter((id) => id !== personId).map(nameOf).filter(Boolean);
          const dates = formatDateRange(row.firstMessageAt, row.lastMessageAt, locale);
          return (
            <li key={row.id} className="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 sm:p-5">
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Title className="min-w-0 text-base leading-snug font-semibold break-words">{row.title}</Title>
                  {row.isGroup && (
                    <span className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
                      <Users className="size-3.5" aria-hidden />
                      {t('group')}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-sm">
                  {t('messageCount', { count: row.messageCount })}
                  {dates && ` · ${dates}`}
                </p>
                <Participants names={row.participants} />
                {others.length > 0 && <p className="text-muted-foreground text-sm break-words">{t('alsoUnder', { names: others.join(', ') })}</p>}
              </div>

              {here === 'rename' && (
                <RenameForm
                  initial={row.title}
                  onCancel={() => close('rename', row.id)}
                  onSave={async (title) => {
                    const saved = await run(row, 'rename', () => actions.rename(row.id, title), t('renamed', { title }));
                    if (saved) close('rename', row.id);
                    return saved;
                  }}
                />
              )}
              {(here === 'move' || here === 'link') && (
                <PickPersonForm
                  kind={here === 'link' && personId === undefined ? 'assign' : here}
                  row={row}
                  people={people}
                  exclude={row.profileIds}
                  onCancel={() => close(here, row.id)}
                  onPick={async (target) => {
                    const name = nameOf(target);
                    const stored =
                      here === 'move'
                        ? await run(row, 'move', () => actions.move(row.id, personId!, target), t('moved', { title: row.title, name }))
                        : await run(
                            row,
                            'link',
                            () => actions.link(row.id, target),
                            t(personId === undefined ? 'assigned' : 'linked', { title: row.title, name }),
                          );
                    if (stored) close(here, row.id);
                    return stored;
                  }}
                />
              )}
              {here === 'unlink' && personId !== undefined && (
                <UnlinkConfirm
                  row={row}
                  name={nameOf(personId)}
                  last={row.profileIds.length <= 1}
                  busy={busy}
                  problem={problem}
                  onCancel={() => close('unlink', row.id)}
                  onConfirm={async () => {
                    const last = row.profileIds.length <= 1;
                    const name = nameOf(personId);
                    const stored = await run(
                      row,
                      'unlink',
                      () => actions.unlink(row.id, personId),
                      t(last ? 'unlinkedLast' : 'unlinked', { title: row.title, name }),
                    );
                    if (stored) close('unlink', row.id);
                  }}
                />
              )}

              {!here && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    id={`${row.id}-rename`}
                    variant="outline"
                    className={busyClass}
                    aria-disabled={ariaBusy}
                    aria-label={t('renameLabel', { title: row.title })}
                    onClick={unlessBusy(() => open('rename', row.id))}
                  >
                    <Pencil aria-hidden />
                    {t('rename')}
                  </Button>
                  {personId !== undefined && (
                    <Button
                      id={`${row.id}-move`}
                      variant="outline"
                      className={busyClass}
                      aria-disabled={ariaBusy}
                      aria-label={t('moveLabel', { title: row.title })}
                      onClick={unlessBusy(() => open('move', row.id))}
                    >
                      <ArrowRightLeft aria-hidden />
                      {t('move')}
                    </Button>
                  )}
                  {(shared || personId === undefined) && (
                    <Button
                      id={`${row.id}-link`}
                      variant="outline"
                      className={busyClass}
                      aria-disabled={ariaBusy}
                      aria-label={t(personId === undefined ? 'assignLabel' : 'linkLabel', { title: row.title })}
                      onClick={unlessBusy(() => open('link', row.id))}
                    >
                      {personId === undefined ? <UserPlus aria-hidden /> : <Link2 aria-hidden />}
                      {t(personId === undefined ? 'assign' : 'link')}
                    </Button>
                  )}
                  {shared && personId !== undefined && (
                    <Button
                      id={`${row.id}-unlink`}
                      variant="ghost"
                      className={busyClass}
                      aria-disabled={ariaBusy}
                      aria-label={t('unlinkLabel', { title: row.title, name: nameOf(personId) })}
                      onClick={unlessBusy(() => open('unlink', row.id))}
                    >
                      <Unlink aria-hidden />
                      {t('unlink')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Participants({ names }: { names: string[] }) {
  const t = useTranslations('conversations');
  const locale = useLocale();
  if (names.length === 0) return null;
  const more = names.length - NAMES_SHOWN;
  const shown = formatNames(names.slice(0, NAMES_SHOWN), locale, more > 0);
  return <p className="text-muted-foreground text-sm break-words">{more > 0 ? t('participantsMore', { names: shown, count: more }) : t('participants', { names: shown })}</p>;
}

/** Inline rename, checked with the same rules the library applies. A failed save keeps what was typed. */
function RenameForm({ initial, onSave, onCancel }: { initial: string; onSave: (title: string) => Promise<boolean>; onCancel: () => void }) {
  const t = useTranslations('conversations.renameForm');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingNow.current) return;
    let title: string;
    try {
      title = normalizeConversationTitle(value);
    } catch (caught) {
      if (!(caught instanceof FieldError)) throw caught;
      setError(
        /empty/.test(caught.message) ? t('required') : /at most/.test(caught.message) ? t('tooLong', { max: CONVERSATION_TITLE_MAX }) : t('invalid'),
      );
      input.current?.focus();
      return;
    }
    setError('');
    setFailed(false);
    savingNow.current = true;
    setSaving(true);
    const stored = await onSave(title);
    if (!stored) {
      // Stay open, keep the text, and put focus on a control that can retry.
      savingNow.current = false;
      setSaving(false);
      setFailed(true);
      input.current?.focus();
    }
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      onKeyDown={onEscape(() => {
        if (!savingNow.current) onCancel();
      })}
      className="bg-muted flex min-w-0 flex-col gap-3 rounded-lg p-4"
    >
      <label htmlFor={`${id}-title`} className="font-medium break-words">
        {t('label')}
      </label>
      <input
        ref={input}
        id={`${id}-title`}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(inputClass, 'h-11')}
      />
      <p id={`${id}-error`} role="alert" className="text-destructive text-sm break-words empty:hidden">
        {error || (failed ? t('failed') : '')}
      </p>
      {/* Same order on screen and for Tab: Cancel, then the main action. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className={busyClass}
          aria-disabled={saving || undefined}
          onClick={() => {
            if (!savingNow.current) onCancel();
          }}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" className={busyClass} aria-disabled={saving || undefined}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

/** Choose a person to move, link or assign a conversation to. Archived people are listed apart, under their own label. */
function PickPersonForm({
  kind,
  row,
  people,
  exclude,
  onPick,
  onCancel,
}: {
  kind: 'move' | 'link' | 'assign';
  row: ConversationRow;
  people: People;
  exclude: string[];
  onPick: (profileId: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useTranslations('conversations.pick');
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const active = people.active.filter((person) => !exclude.includes(person.id));
  const archived = people.archived.filter((person) => !exclude.includes(person.id));
  const nobody = active.length + archived.length === 0;
  const cancel = useRef<HTMLButtonElement>(null);
  // With nobody to choose there is no select: focus Cancel, so focus never falls to <body>.
  useEffect(() => (nobody ? cancel.current : select.current)?.focus(), [nobody]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingNow.current) return;
    if (!value) {
      setError(true);
      select.current?.focus();
      return;
    }
    setError(false);
    setFailed(false);
    savingNow.current = true;
    setSaving(true);
    const stored = await onPick(value);
    if (!stored) {
      savingNow.current = false;
      setSaving(false);
      setFailed(true);
      select.current?.focus();
    }
  };

  const hint = kind === 'move' ? (row.isGroup ? t('moveHintGroup') : t('moveHint')) : t(`${kind}Hint`);
  const describedBy = [error && `${id}-error`, `${id}-hint`].filter(Boolean).join(' ');
  return (
    <form
      noValidate
      onSubmit={submit}
      onKeyDown={onEscape(() => {
        if (!savingNow.current) onCancel();
      })}
      className="bg-muted flex min-w-0 flex-col gap-3 rounded-lg p-4"
    >
      <label htmlFor={nobody ? undefined : `${id}-person`} className="font-medium break-words">
        {t(`${kind}Label`, { title: row.title })}
      </label>
      {nobody ? (
        <p className="text-muted-foreground text-sm">{t('nobody')}</p>
      ) : (
        <>
          <select
            ref={select}
            id={`${id}-person`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-required
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(inputClass, 'h-11')}
          >
            <option value="">{t('choose')}</option>
            {active.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
            {archived.length > 0 && (
              <optgroup label={t('archivedGroup')}>
                {archived.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <p id={`${id}-hint`} className="text-muted-foreground text-sm leading-relaxed break-words">
            {hint}
          </p>
          <p id={`${id}-error`} role="alert" className="text-destructive text-sm break-words empty:hidden">
            {error ? t('required') : failed ? t('failed') : ''}
          </p>
        </>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          ref={cancel}
          type="button"
          variant="outline"
          className={busyClass}
          aria-disabled={saving || undefined}
          onClick={() => {
            if (!savingNow.current) onCancel();
          }}
        >
          {t('cancel')}
        </Button>
        {!nobody && (
          <Button type="submit" className={busyClass} aria-disabled={saving || undefined}>
            {t(`${kind}Confirm`)}
          </Button>
        )}
      </div>
    </form>
  );
}

function UnlinkConfirm({
  row,
  name,
  last,
  busy,
  problem,
  onCancel,
  onConfirm,
}: {
  row: ConversationRow;
  name: string;
  last: boolean;
  busy: boolean;
  /** Why the last attempt failed; '' when it did not. */
  problem: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('conversations.unlinkConfirm');
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="bg-muted flex min-w-0 flex-col gap-3 rounded-lg p-4"
      onKeyDown={onEscape(() => {
        if (!busy) onCancel();
      })}
    >
      <p id={titleId} className="font-semibold break-words">
        {t('title', { title: row.title, name })}
      </p>
      <p className="text-muted-foreground text-sm leading-relaxed break-words">{t(last ? 'bodyLast' : 'body', { name })}</p>
      <p role="alert" className="text-destructive text-sm break-words empty:hidden">
        {problem}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button ref={cancel} variant="outline" className={busyClass} aria-disabled={busy || undefined} onClick={() => !busy && onCancel()}>
          {t('cancel')}
        </Button>
        <Button className={busyClass} aria-disabled={busy || undefined} onClick={() => !busy && onConfirm()}>
          <Unlink aria-hidden />
          {t('confirm')}
        </Button>
      </div>
    </div>
  );
}
