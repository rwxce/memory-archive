'use client';

import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, History, NotebookPen, Pencil, Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { BackPill } from '@/components/back-pill';
import { ConversationList } from '@/components/conversation-list';
import { LibraryNotice } from '@/components/library-notice';
import { PersonNote } from '@/components/note-panels';
import { ArchiveConfirm } from '@/components/person-actions';
import { OverflowMenu, type OverflowItem } from '@/components/overflow-menu';
import { PageTitle } from '@/components/page-title';
import { PersonAvatar } from '@/components/person-avatar';
import { PersonBento, PersonStats } from '@/components/person-overview';
import { yearSpan } from '@/components/person-meta';
import { PillButton } from '@/components/pill-button';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { SectionCard } from '@/components/section-card';
import { Shell } from '@/components/screen-shell';
import { useConversationActions } from '@/hooks/use-conversation-actions';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { usePersonOverview } from '@/hooks/use-person-overview';
import { useProfileActions } from '@/hooks/use-people';
import { Link } from '@/i18n/navigation';
import type { PersonDetails } from '@/lib/usecases/library';
import { formatDay } from './format';
import { isMediaMessage } from './message-media';

function BackLink() {
  const t = useTranslations('nav');
  return <BackPill href="/people">{t('tabs.people')}</BackPill>;
}

/**
 * One person: who they are, what is kept about them (counts, a bar per year, a few photos) and the
 * conversations filed under them. The person is chosen by `?id=` (a static export has no dynamic
 * routes). An id that matches no one gets a calm "not found" with the way back, never an error.
 * Edit, archive, the person's note, search and the imports live in the "..." menu.
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
  const tc = useTranslations('conversation');
  const locale = useLocale();
  const id = useSearchParams().get('id');
  const result = usePersonDetails(id);
  const overviewState = usePersonOverview(id);
  const overview = overviewState.status === 'ready' ? overviewState.overview : undefined;
  const profiles = useProfileActions();
  const conversationActions = useConversationActions();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const conversationsRef = useRef<HTMLHeadingElement>(null);
  const formOpen = useRef(false);
  formOpen.current = editing;

  const restoreFocus = (menuId: string) => {
    // After the DOM settles: back to the "..." button, or to the heading if the screen changed shape.
    setTimeout(() => {
      if (formOpen.current) return;
      (document.getElementById(menuId) ?? headingRef.current)?.focus();
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
  if (result.status === 'not-found') {
    return (
      <Shell message={message}>
        <SectionCard className="gap-3 p-6">
          <PageTitle as="h1" className="text-headline">
            {t('notFoundTitle')}
          </PageTitle>
          <p className="text-t2 leading-relaxed">{t('notFoundBody')}</p>
          <BackLink />
        </SectionCard>
      </Shell>
    );
  }

  const { person, conversations, people } = result.details satisfies PersonDetails;
  const archived = person.archivedAt !== null;
  const menuId = `${person.id}-menu`;

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
    restoreFocus(menuId);
  };

  if (editing) {
    return (
      <Shell message={message}>
        <PageTitle ref={headingRef} tabIndex={-1} className="text-headline">
          {tp('form.editTitle', { name: person.displayName })}
        </PageTitle>
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

  const since = person.firstMessageAt ? t('since', { year: person.firstMessageAt.slice(0, 4) }) : '';
  // Phone: "Mother · since 2014". Desktop: "Mother · 3 conversations · 2014-2024".
  const phoneMeta = [person.relationship, since].filter(Boolean).join(' · ');
  const wideMeta = [person.relationship, tp('conversations', { count: person.conversationCount }), yearSpan(person)].filter(Boolean).join(' · ');

  const items: OverflowItem[] = [
    {
      id: `${person.id}-edit`,
      label: tp('editLabel', { name: person.displayName }),
      icon: <Pencil aria-hidden />,
      onSelect: () => {
        setMessage('');
        setProblem('');
        setEditing(true);
      },
    },
    archived
      ? {
          id: `${person.id}-restore`,
          label: tp('restoreLabel', { name: person.displayName }),
          icon: <ArchiveRestore aria-hidden />,
          onSelect: async () => {
            if (await run('restored', () => profiles.unarchive(person.id))) restoreFocus(menuId);
          },
        }
      : {
          id: `${person.id}-archive`,
          label: tp('archiveLabel', { name: person.displayName }),
          icon: <Archive aria-hidden />,
          onSelect: () => setConfirming(true),
        },
    {
      id: `${person.id}-note`,
      label: t('menuNote'),
      icon: <NotebookPen aria-hidden />,
      onSelect: () => setNoteOpen((open) => !open),
    },
    { id: `${person.id}-search`, label: t('menuSearch', { name: person.displayName }), icon: <Search aria-hidden />, href: `/search?person=${encodeURIComponent(person.id)}` },
  ];
  if (conversations.length > 0) {
    items.push({
      id: `${person.id}-imports`,
      label: t('importsLink'),
      icon: <History aria-hidden />,
      href: `/import/history?person=${encodeURIComponent(person.id)}`,
    });
  }

  const excerpts = overview?.excerpts ?? [];

  return (
    <Shell message={message}>
      <div className="flex items-center justify-between gap-3">
        <BackLink />
        <OverflowMenu id={menuId} label={t('menuLabel', { name: person.displayName })} items={items} />
      </div>

      {confirming && (
        <ArchiveConfirm
          person={person}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
            restoreFocus(menuId);
          }}
          onArchive={async () => {
            // On failure the confirmation stays open and focus stays on its button.
            if (await run('archived', () => profiles.archive(person.id))) {
              setConfirming(false);
              restoreFocus(menuId);
            }
          }}
        />
      )}
      <p role="alert" className="text-destructive text-sm break-words empty:hidden">
        {problem}
      </p>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-x-8 lg:gap-y-6">
        <header className="flex min-w-0 items-end gap-4 lg:col-start-1 lg:row-start-1 lg:items-center lg:gap-[22px]">
          <PersonAvatar name={person.displayName} size="xl" tone="accent" className="size-22 rounded-[28px] text-[3.25rem] lg:size-[104px] lg:rounded-[34px] lg:text-6xl" />
          <div className="flex min-w-0 flex-col gap-1">
            <PageTitle ref={headingRef} tabIndex={-1} className="text-[3.25rem] leading-[0.95] lg:text-7xl lg:leading-[0.92]">
              {person.displayName}
            </PageTitle>
            {(phoneMeta || wideMeta) && (
              <>
                <p className="text-mu text-[15px] [overflow-wrap:anywhere] lg:hidden">{phoneMeta}</p>
                <p className="text-mu hidden text-[15px] [overflow-wrap:anywhere] lg:block">{wideMeta}</p>
              </>
            )}
            {archived && (
              <p>
                <span className="bg-sf2 text-t2 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium">{t('archivedBadge')}</span>
              </p>
            )}
          </div>
        </header>

        {person.description && (
          <p className="font-display bg-peach text-ink rounded-[18px] px-4 py-3.5 text-xl leading-snug break-words whitespace-pre-line italic lg:col-span-2 lg:row-start-2 lg:max-w-[680px] lg:rounded-[22px] lg:px-[22px] lg:py-[18px] lg:text-[1.625rem]">
            {person.description}
          </p>
        )}

        {overview && <PersonStats overview={overview} className="lg:col-start-2 lg:row-start-1" />}
      </div>

      {archived && <p className="text-mu text-sm leading-relaxed break-words">{t('archivedNote')}</p>}

      {noteOpen && <PersonNote personId={person.id} onClose={() => setNoteOpen(false)} />}

      <PersonBento personId={person.id} overview={overview} />

      <div className={excerpts.length > 0 ? 'grid gap-7 lg:grid-cols-2 lg:gap-7' : undefined}>
        <section className="flex flex-col gap-2.5 lg:gap-3" aria-labelledby="person-conversations">
          <h2 id="person-conversations" ref={conversationsRef} tabIndex={-1} className="font-display text-headline [overflow-wrap:anywhere] outline-none">
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
            <SectionCard className="text-t2 leading-relaxed break-words">{t('noConversations', { name: person.displayName })}</SectionCard>
          )}
        </section>

        {excerpts.length > 0 && overview && (
          <section className="flex flex-col gap-3 max-lg:hidden" aria-labelledby="person-favorites">
            <h2 id="person-favorites" className="font-display text-headline [overflow-wrap:anywhere]">
              {t('favoritesTitle')}
            </h2>
            {excerpts.map((item, i) => (
              <figure key={`${item.conversationId}:${item.id}`} className={`${i % 2 === 0 ? 'bg-butter' : 'bg-ac-soft'} m-0 flex flex-col gap-2.5 rounded-[20px] p-[18px]`}>
                <blockquote dir="auto" className="m-0 line-clamp-4 text-base leading-normal break-words">
                  {item.body || (isMediaMessage(item.type) ? tc(`media.${item.type}`) : '')}
                </blockquote>
                <figcaption dir="auto" className="text-t2 text-xs break-words">
                  {[item.participantName, formatDay(item.sentAt, locale)].filter(Boolean).join(' · ')}
                </figcaption>
              </figure>
            ))}
            <PillButton asChild variant="ghost-link" className="w-fit px-0">
              <Link href={`/person/favorites?id=${encodeURIComponent(person.id)}`}>{t('showFavorites', { count: overview.favorites })}</Link>
            </PillButton>
          </section>
        )}
      </div>
    </Shell>
  );
}
