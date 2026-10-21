'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileUp, History, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ConversationList } from '@/components/conversation-list';
import { LibraryNotice } from '@/components/library-notice';
import { PersonActions } from '@/components/person-actions';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useConversationActions } from '@/hooks/use-conversation-actions';
import { useLibrary } from '@/hooks/use-library';
import { usePeople, useProfileActions } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import type { Person } from '@/lib/usecases/library';
import { initialsOf } from './format';

/**
 * The People screen. `whenNoProfiles` (the welcome, on the home page) takes
 * over only while the library holds no profile at all, archived ones included.
 */
export function PeopleScreen({ whenNoProfiles }: { whenNoProfiles?: ReactNode }) {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    // First run on the home page: a library that cannot open still gets the welcome
    // (which shows the notice under it), never only an error.
    if (whenNoProfiles && (state.status === 'unavailable' || state.status === 'error')) return <>{whenNoProfiles}</>;
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PeopleContent whenNoProfiles={whenNoProfiles} onRetry={retry} />;
}

type Editing = { mode: 'create' } | { mode: 'edit'; person: Person };

function PeopleContent({ whenNoProfiles, onRetry }: { whenNoProfiles?: ReactNode; onRetry: () => void }) {
  const t = useTranslations('people');
  const tl = useTranslations('library');
  const result = usePeople();
  const actions = useProfileActions();
  const conversationActions = useConversationActions();
  const unassignedRef = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<Editing>();
  const [confirming, setConfirming] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string>(undefined);
  const archivedId = useId();
  const formOpen = useRef(false);
  formOpen.current = editing !== undefined;

  /** Remember the id of the button that opened a form or panel, to give focus back when it closes. */
  const remember = (buttonId: string) => {
    opener.current = buttonId;
  };
  const restoreFocus = () => {
    // After the DOM settles. If the button is gone (an archived card), the heading takes focus.
    setTimeout(() => {
      // A form opened in the meantime has the focus; leave it alone.
      if (formOpen.current) return;
      const target = (opener.current && document.getElementById(opener.current)) || headingRef.current;
      target?.focus();
    });
  };

  if (result.status === 'loading') {
    return (
      <Shell message={message}>
        <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
      </Shell>
    );
  }
  if (result.status === 'error') {
    return (
      <Shell message={message}>
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={onRetry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }

  const { active, archived, unassigned } = result.people;
  if (active.length + archived.length + unassigned.length === 0 && whenNoProfiles && !editing) return <>{whenNoProfiles}</>;

  /** Runs a change from the list; true when it was stored. */
  const run = async (name: string, done: string, work: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    setProblem('');
    setMessage('');
    try {
      await work();
      setMessage(t(done, { name }));
      return true;
    } catch {
      setProblem(t('actionFailed', { name }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openForm = (next: Editing, buttonId: string) => {
    remember(buttonId);
    setMessage('');
    setProblem('');
    setEditing(next);
  };

  const closeForm = () => {
    setEditing(undefined);
    restoreFocus();
  };

  const submitForm = async (values: ProfileFormValues) => {
    if (!editing) return;
    // Resolves after the list has reloaded, so closing the form shows the new list at once.
    if (editing.mode === 'create') {
      const created = await actions.create(values);
      setMessage(t('created', { name: created.displayName }));
    } else {
      const updated = await actions.update(editing.person.id, values);
      setMessage(t('updated', { name: updated.displayName }));
    }
    closeForm();
  };

  if (editing) {
    const title = editing.mode === 'create' ? t('form.createTitle') : t('form.editTitle', { name: editing.person.displayName });
    return (
      <Shell message={message}>
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl break-words outline-none">
          {title}
        </h1>
        <ProfileForm initial={editing.mode === 'edit' ? editing.person : undefined} onSubmit={submitForm} onCancel={closeForm} />
      </Shell>
    );
  }

  const card = (person: Person, isArchived: boolean) => (
    <PersonCard
      key={person.id}
      person={person}
      archived={isArchived}
      busy={busy}
      confirming={confirming === person.id}
      onEdit={() => openForm({ mode: 'edit', person }, `${person.id}-edit`)}
      onAskArchive={() => {
        remember(`${person.id}-archive`);
        setConfirming(person.id);
      }}
      onCancelArchive={() => {
        setConfirming(undefined);
        restoreFocus();
      }}
      onArchive={async () => {
        // On failure the confirmation stays open and focus stays on its button.
        if (await run(person.displayName, 'archived', () => actions.archive(person.id))) {
          setConfirming(undefined);
          restoreFocus();
        }
      }}
      onRestore={async () => {
        remember(`${person.id}-restore`);
        if (await run(person.displayName, 'restored', () => actions.unarchive(person.id))) restoreFocus();
      }}
    />
  );

  return (
    <Shell message={message}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl outline-none">
            {t('title')}
          </h1>
          <p className="text-muted-foreground">{t('intro')}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link href="/import">
              <FileUp aria-hidden />
              {t('import')}
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/import/history">
              <History aria-hidden />
              {t('history')}
            </Link>
          </Button>
          <Button
            id="add-person"
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) openForm({ mode: 'create' }, 'add-person');
            }}
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        </div>
      </div>

      <p role="alert" className="text-destructive text-sm break-words empty:hidden">
        {problem}
      </p>

      {active.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label={t('title')}>
          {active.map((person) => card(person, false))}
        </ul>
      ) : (
        <section className="bg-card flex flex-col gap-2 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">{t('emptyTitle')}</h2>
          <p className="text-muted-foreground leading-relaxed">{archived.length > 0 ? t('allArchivedBody') : t('emptyBody')}</p>
        </section>
      )}

      {unassigned.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby={`${archivedId}-unassigned`}>
          <div className="flex flex-col gap-1">
            <h2 id={`${archivedId}-unassigned`} ref={unassignedRef} tabIndex={-1} className="text-xl font-semibold outline-none">
              {t('unassignedTitle')}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{t('unassignedHint')}</p>
          </div>
          <ConversationList
            conversations={unassigned}
            people={result.people}
            actions={conversationActions}
            announce={setMessage}
            onGone={() => (unassignedRef.current ?? headingRef.current)?.focus()}
          />
        </section>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby={`${archivedId}-title`}>
          <h2 id={`${archivedId}-title`} className="sr-only">
            {t('archivedTitle')}
          </h2>
          <Button
            variant="ghost"
            className="self-start"
            aria-expanded={showArchived}
            aria-controls={archivedId}
            onClick={() => setShowArchived((v) => !v)}
          >
            <ChevronDown className={cn('transition-transform motion-reduce:transition-none', showArchived && 'rotate-180')} aria-hidden />
            {showArchived ? t('hideArchived') : t('showArchived', { count: archived.length })}
          </Button>
          <div id={archivedId} hidden={!showArchived} className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t('archivedHint')}</p>
            <ul className="flex flex-col gap-3">{archived.map((person) => card(person, true))}</ul>
          </div>
        </section>
      )}
    </Shell>
  );
}

function PersonCard({
  person,
  archived,
  ...actions
}: {
  person: Person;
  archived: boolean;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useTranslations('people');
  // Active people are h2 under the page title; the archived ones sit one level down, under their section's h2.
  const Name = archived ? 'h3' : 'h2';

  return (
    <li className="bg-card flex min-w-0 flex-col gap-4 rounded-xl border p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className="bg-primary/15 text-primary flex size-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
        >
          {initialsOf(person.displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <Name className="text-lg leading-tight font-semibold">
            <Link
              href={`/person?id=${encodeURIComponent(person.id)}`}
              className="focus-visible:ring-ring/50 -my-2 block truncate rounded-md py-2 underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
            >
              {person.displayName}
            </Link>
          </Name>
          {person.relationship && <p className="text-muted-foreground truncate text-sm">{person.relationship}</p>}
          <p className="text-muted-foreground text-sm">{t('conversations', { count: person.conversationCount })}</p>
        </div>
        <ChevronRight className="text-muted-foreground size-5 shrink-0" aria-hidden />
      </div>
      <PersonActions person={person} archived={archived} {...actions} />
    </li>
  );
}
