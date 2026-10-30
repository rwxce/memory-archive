'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ConversationList } from '@/components/conversation-list';
import { Eyebrow } from '@/components/eyebrow';
import { LibraryNotice } from '@/components/library-notice';
import { PageTitle } from '@/components/page-title';
import { ProfileAvatar } from '@/components/profile-avatar';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { Shell } from '@/components/screen-shell';
import { cn } from '@/components/ui/utils';
import { useConversationActions } from '@/hooks/use-conversation-actions';
import { useLibrary } from '@/hooks/use-library';
import { usePeople, useProfileActions, type PhotoChange } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import type { Person } from '@/lib/usecases/library';
import { featuredPerson, personMeta } from './person-meta';

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

type Editing = { mode: 'create' };

function PeopleContent({ whenNoProfiles, onRetry }: { whenNoProfiles?: ReactNode; onRetry: () => void }) {
  const t = useTranslations('people');
  const tl = useTranslations('library');
  const result = usePeople();
  const actions = useProfileActions();
  const conversationActions = useConversationActions();
  const unassignedRef = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<Editing>();
  const [showArchived, setShowArchived] = useState(false);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<string>(undefined);
  const archivedId = useId();
  const formOpen = useRef(false);
  formOpen.current = editing !== undefined;

  // The desktop sidebar's "Add a person" arrives as /people?new=1: open the form once, then tidy the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') !== '1') return;
    params.delete('new');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    setEditing({ mode: 'create' });
  }, []);

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
        <SectionCard role="alert">
          <p>{t('loadFailed')}</p>
          <div>
            <PillButton variant="outlined" onClick={onRetry}>
              {tl('retry')}
            </PillButton>
          </div>
        </SectionCard>
      </Shell>
    );
  }

  const { active, archived, unassigned } = result.people;
  if (active.length + archived.length + unassigned.length === 0 && whenNoProfiles && !editing) return <>{whenNoProfiles}</>;

  const openForm = (next: Editing, buttonId: string) => {
    remember(buttonId);
    setMessage('');
    setEditing(next);
  };

  const closeForm = () => {
    setEditing(undefined);
    restoreFocus();
  };

  const submitForm = async (values: ProfileFormValues, photo: PhotoChange) => {
    // Resolves after the list has reloaded, so closing the form shows the new list at once.
    const created = await actions.create(values);
    let photoSaved = true;
    try {
      await actions.applyPhoto(created.id, photo);
    } catch {
      photoSaved = false;
    }
    setMessage(t(photoSaved ? 'created' : 'createdNoPhoto', { name: created.displayName }));
    closeForm();
  };

  if (editing) {
    return (
      <Shell message={message}>
        <PageTitle ref={headingRef} tabIndex={-1}>
          {t('form.createTitle')}
        </PageTitle>
        <ProfileForm photo={{}} onSubmit={submitForm} onCancel={closeForm} />
      </Shell>
    );
  }

  const featured = featuredPerson(active);
  const card = (person: Person, isArchived: boolean) => <PersonCard key={person.id} person={person} archived={isArchived} featured={person === featured} />;

  return (
    <Shell message={message}>
      <header className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <PageTitle ref={headingRef} tabIndex={-1}>
            {t('title')}
          </PageTitle>
        </div>
        <button
          id="add-person"
          type="button"
          aria-label={t('add')}
          onClick={() => openForm({ mode: 'create' }, 'add-person')}
          className="bg-ac text-ac-ink focus-visible:ring-ring/50 flex size-[50px] shrink-0 items-center justify-center rounded-2xl outline-none focus-visible:ring-[3px] aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          <Plus className="size-[22px]" strokeWidth={2} aria-hidden />
        </button>
      </header>
      <p className="text-t2 leading-relaxed">{t('intro')}</p>

      {active.length > 0 ? (
        <ul className="flex flex-col gap-3.5" aria-label={t('title')}>
          {/* The person with the most recent message comes first, as a larger card. */}
          {featured && card(featured, false)}
          {active.filter((person) => person !== featured).map((person) => card(person, false))}
        </ul>
      ) : (
        <SectionCard className="gap-2 p-6">
          <h2 className="font-display text-name">{t('emptyTitle')}</h2>
          <p className="text-muted-foreground leading-relaxed">{archived.length > 0 ? t('allArchivedBody') : t('emptyBody')}</p>
        </SectionCard>
      )}

      {unassigned.length > 0 && (
        <section className="flex flex-col gap-3 pt-1.5" aria-labelledby={`${archivedId}-unassigned`}>
          <div className="flex flex-col gap-1">
            <h2
              id={`${archivedId}-unassigned`}
              ref={unassignedRef}
              tabIndex={-1}
              className="text-mu text-[13px] font-semibold tracking-wider uppercase outline-none"
            >
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
          <PillButton
            variant="ghost-link"
            className="self-start"
            aria-expanded={showArchived}
            aria-controls={archivedId}
            onClick={() => setShowArchived((v) => !v)}
          >
            <ChevronDown className={cn('transition-transform motion-reduce:transition-none', showArchived && 'rotate-180')} aria-hidden />
            {showArchived ? t('hideArchived') : t('showArchived', { count: archived.length })}
          </PillButton>
          <div id={archivedId} hidden={!showArchived} className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t('archivedHint')}</p>
            <ul className="flex flex-col gap-3">{archived.map((person) => card(person, true))}</ul>
          </div>
        </section>
      )}
    </Shell>
  );
}

function PersonCard({ person, archived, featured }: { person: Person; archived: boolean; featured: boolean }) {
  const t = useTranslations('people');
  // Active people are h2 under the page title; the archived ones sit one level down, under their section's h2.
  const Name = archived ? 'h3' : 'h2';
  const meta = personMeta(person, (count) => t('conversations', { count }));

  return (
    <SectionCard as="li" tone={featured ? 'soft' : 'sf'} className={featured ? 'gap-3.5 rounded-[26px] p-4' : 'gap-3 rounded-[22px] px-4 py-3.5'}>
      <div className="relative flex items-center gap-3.5">
        <ProfileAvatar person={person} size={featured ? 'lg' : 'md'} tone={featured ? 'accent' : 'auto'} />
        <div className="min-w-0 flex-1">
          <Name className={featured ? 'font-display text-headline break-words' : 'font-display text-name break-words'}>
            {/* The link covers the whole card. Edit and archive live in the person's own menu. */}
            <Link
              href={`/person?id=${encodeURIComponent(person.id)}`}
              className="focus-visible:ring-ring/50 rounded-md outline-none after:absolute after:-inset-3 after:rounded-[22px] focus-visible:ring-[3px]"
            >
              {person.displayName}
            </Link>
          </Name>
          <p className={featured ? 'text-t2 text-[13px]' : 'text-mu text-[13px]'}>{meta}</p>
        </div>
        <ChevronRight className="text-mu size-5 shrink-0 rtl:rotate-180" aria-hidden />
      </div>
      {/* TODO(redesign-data): the featured card shows a 4-tile photo preview (three recent photos and a "+N" count); needs a media-preview use case. */}
    </SectionCard>
  );
}
