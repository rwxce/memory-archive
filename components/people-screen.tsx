'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-header';
import { LibraryNotice } from '@/components/library-notice';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useLibrary } from '@/hooks/use-library';
import { usePeople, useProfileActions } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import type { Person } from '@/lib/usecases/library';
import { initialsOf } from './format';

/**
 * Same top spacing as the Welcome, so nothing jumps between them. The polite
 * status region lives here, in every state of the screen, so a message set
 * while the form closes is announced by a region that was already on screen.
 */
function Shell({ children, message = '' }: { children: ReactNode; message?: string }) {
  const t = useTranslations('people');
  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-20">
        <div role="status" aria-live="polite" className="text-muted-foreground min-h-5 text-sm">
          {message}
        </div>
        {children}
        <Link
          href="/welcome"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-md text-sm underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('about')}
        </Link>
      </main>
    </>
  );
}

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

  const { active, archived } = result.people;
  if (active.length + archived.length === 0 && whenNoProfiles && !editing) return <>{whenNoProfiles}</>;

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
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl outline-none">
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

      <p role="alert" className="text-destructive text-sm empty:hidden">
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
  busy,
  confirming,
  onEdit,
  onAskArchive,
  onCancelArchive,
  onArchive,
  onRestore,
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
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  // Active people are h2 under the page title; the archived ones sit one level down, under their section's h2.
  const Name = archived ? 'h3' : 'h2';
  // aria-disabled, not disabled: a busy button keeps focus (a disabled one drops it).
  const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
  const ariaBusy = busy || undefined;
  const unlessBusy = (action: () => void) => () => {
    if (!busy) action();
  };

  return (
    <li className="bg-card flex flex-col gap-4 rounded-xl border p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <span
          aria-hidden
          className="bg-primary/15 text-primary flex size-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
        >
          {initialsOf(person.displayName)}
        </span>
        <div className="min-w-0">
          <Name className="truncate text-lg leading-tight font-semibold">{person.displayName}</Name>
          {person.relationship && <p className="text-muted-foreground truncate text-sm">{person.relationship}</p>}
          <p className="text-muted-foreground text-sm">{t('conversations', { count: person.conversationCount })}</p>
        </div>
      </div>

      {confirming ? (
        <div
          role="group"
          aria-labelledby={titleId}
          className="bg-muted flex flex-col gap-3 rounded-lg p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              if (!busy) onCancelArchive();
            }
          }}
        >
          <p id={titleId} className="font-semibold">
            {t('archiveConfirm.title', { name: person.displayName })}
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">{t('archiveConfirm.body', { name: person.displayName })}</p>
          {/* Same order on screen and for Tab: Cancel first (it takes focus), then Archive. */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button ref={cancelRef} variant="outline" className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onCancelArchive)}>
              {t('archiveConfirm.cancel')}
            </Button>
            <Button className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onArchive)}>
              <Archive aria-hidden />
              {t('archiveConfirm.confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            id={`${person.id}-edit`}
            variant="outline"
            className={busyClass}
            aria-disabled={ariaBusy}
            aria-label={t('editLabel', { name: person.displayName })}
            onClick={unlessBusy(onEdit)}
          >
            <Pencil aria-hidden />
            {t('edit')}
          </Button>
          {archived ? (
            <Button
              id={`${person.id}-restore`}
              variant="outline"
              className={busyClass}
              aria-disabled={ariaBusy}
              aria-label={t('restoreLabel', { name: person.displayName })}
              onClick={unlessBusy(onRestore)}
            >
              <ArchiveRestore aria-hidden />
              {t('restore')}
            </Button>
          ) : (
            <Button
              id={`${person.id}-archive`}
              variant="ghost"
              className={busyClass}
              aria-disabled={ariaBusy}
              aria-label={t('archiveLabel', { name: person.displayName })}
              onClick={unlessBusy(onAskArchive)}
            >
              <Archive aria-hidden />
              {t('archive')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
