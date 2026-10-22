'use client';

import { useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ConversationList } from '@/components/conversation-list';
import { LibraryNotice } from '@/components/library-notice';
import { PersonActions } from '@/components/person-actions';
import { PersonSections } from '@/components/person-sections';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useConversationActions } from '@/hooks/use-conversation-actions';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { useProfileActions } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import type { PersonDetails } from '@/lib/usecases/library';
import { initialsOf } from './format';

const backLinkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

function BackLink() {
  const t = useTranslations('person');
  return (
    <Link href="/people" className={backLinkClass}>
      <ArrowLeft className="size-4" aria-hidden />
      {t('back')}
    </Link>
  );
}

/**
 * One person: who they are and the conversations kept under them. The person
 * is chosen by `?id=` (a static export has no dynamic routes). An id that
 * matches no one gets a calm "not found" with the way back, never an error.
 */
export function PersonScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonContent onRetry={retry} />;
}

function PersonContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('person');
  const tp = useTranslations('people');
  const tl = useTranslations('library');
  const id = useSearchParams().get('id');
  const result = usePersonDetails(id);
  const profiles = useProfileActions();
  const conversationActions = useConversationActions();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const conversationsRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string>(undefined);
  const formOpen = useRef(false);
  formOpen.current = editing;

  const restoreFocus = () => {
    // After the DOM settles. If the button is gone (archive became restore), the heading takes focus.
    setTimeout(() => {
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
        <BackLink />
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
  if (result.status === 'not-found') {
    return (
      <Shell message={message}>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{t('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{t('notFoundBody')}</p>
          <BackLink />
        </section>
      </Shell>
    );
  }

  const { person, conversations, people } = result.details satisfies PersonDetails;
  const archived = person.archivedAt !== null;

  /** Runs a change to this person; true when it was stored. */
  const run = async (done: string, work: () => Promise<unknown>) => {
    if (busyNow.current) return false;
    busyNow.current = true;
    setBusy(true);
    setProblem('');
    setMessage('');
    try {
      await work();
      setMessage(tp(done, { name: person.displayName }));
      return true;
    } catch {
      setProblem(tp('actionFailed', { name: person.displayName }));
      return false;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  };

  const closeForm = () => {
    setEditing(false);
    restoreFocus();
  };

  if (editing) {
    return (
      <Shell message={message}>
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl break-words outline-none">
          {tp('form.editTitle', { name: person.displayName })}
        </h1>
        <ProfileForm
          initial={person}
          onCancel={closeForm}
          onSubmit={async (values: ProfileFormValues) => {
            const updated = await profiles.update(person.id, values);
            setMessage(tp('updated', { name: updated.displayName }));
            closeForm();
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell message={message}>
      <BackLink />
      <header className="flex items-start gap-4">
        <span
          aria-hidden
          className="bg-primary/15 text-primary flex size-16 shrink-0 items-center justify-center rounded-full text-2xl font-semibold"
        >
          {initialsOf(person.displayName)}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl break-words outline-none">
            {person.displayName}
          </h1>
          {person.relationship && <p className="text-muted-foreground break-words">{person.relationship}</p>}
          {archived && (
            <p>
              <span className="bg-secondary text-secondary-foreground inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium">
                {t('archivedBadge')}
              </span>
            </p>
          )}
        </div>
      </header>

      {archived && <p className="text-muted-foreground text-sm leading-relaxed break-words">{t('archivedNote')}</p>}
      {person.description && <p className="leading-relaxed break-words whitespace-pre-line">{person.description}</p>}

      <PersonActions
        person={person}
        archived={archived}
        busy={busy}
        confirming={confirming}
        onEdit={() => {
          opener.current = `${person.id}-edit`;
          setMessage('');
          setProblem('');
          setEditing(true);
        }}
        onAskArchive={() => {
          opener.current = `${person.id}-archive`;
          setConfirming(true);
        }}
        onCancelArchive={() => {
          setConfirming(false);
          restoreFocus();
        }}
        onArchive={async () => {
          // On failure the confirmation stays open and focus stays on its button.
          if (await run('archived', () => profiles.archive(person.id))) {
            setConfirming(false);
            restoreFocus();
          }
        }}
        onRestore={async () => {
          opener.current = `${person.id}-restore`;
          if (await run('restored', () => profiles.unarchive(person.id))) restoreFocus();
        }}
      />
      <p role="alert" className="text-destructive text-sm break-words empty:hidden">
        {problem}
      </p>

      <PersonSections personId={person.id} />

      <section className="flex flex-col gap-3" aria-labelledby="person-conversations">
        <h2 id="person-conversations" ref={conversationsRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {t('conversationsTitle')}
        </h2>
        {conversations.length > 0 ? (
          <ConversationList
            conversations={conversations}
            people={people}
            personId={person.id}
            actions={conversationActions}
            announce={setMessage}
            onGone={() => conversationsRef.current?.focus()}
          />
        ) : (
          <p className="bg-card text-muted-foreground rounded-xl border p-5 leading-relaxed break-words">{t('noConversations', { name: person.displayName })}</p>
        )}
        {conversations.length > 0 && (
          <Link
            href={`/import/history?person=${encodeURIComponent(person.id)}`}
            className="text-primary focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-md text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
          >
            {t('importsLink')}
          </Link>
        )}
      </section>
    </Shell>
  );
}
