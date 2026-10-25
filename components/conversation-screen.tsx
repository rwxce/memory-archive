'use client';

import { useMemo } from 'react';
import { Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { ConversationBody, type FeedSource } from '@/components/conversation-body';
import { ConversationNote } from '@/components/note-panels';
import { LibraryNotice } from '@/components/library-notice';
import { BackPill } from '@/components/back-pill';
import { PageTitle } from '@/components/page-title';
import { PersonAvatar } from '@/components/person-avatar';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { FeedShell, Shell } from '@/components/screen-shell';
import { isDateParam, parseMessageParam, useConversation, type OpenConversation } from '@/hooks/use-conversation';
import { useLibrary, useLibraryDeps } from '@/hooks/use-library';
import { Link } from '@/i18n/navigation';
import { findMessageOffsetByDate, findMessageOffsetById, getMessageWindow, listConversationDays } from '@/lib/usecases/conversation-view';
import { parseBackParam } from './conversation-link';
import { formatNames } from './format';
import { yearSpan } from './person-meta';

/**
 * One conversation: its title, who it is kept under, how many messages and from when to when, and
 * the virtualized message feed. The conversation is chosen by `?id=` (a static export has no
 * dynamic routes); `?date=YYYY-MM-DD` opens at that day, `?message=` (a local message id) then scrolls to that message and marks it, and `?from=` is the person to go back to.
 * An id that matches nothing gets a calm "not found", never an error.
 */
export function ConversationScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <ConversationContent onRetry={retry} />;
}

function ConversationContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('conversation');
  const tl = useTranslations('library');
  const tn = useTranslations('nav');
  const locale = useLocale();
  const params = useSearchParams();
  const id = params.get('id');
  const date = params.get('date');
  const from = params.get('from');
  const backTo = parseBackParam(params.get('back'));
  const messageId = parseMessageParam(params.get('message'));
  const { state, retry } = useConversation(id, isDateParam(date) ? date : null);

  if (state.status === 'loading') {
    return (
      <Shell>
        <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell>
        <SectionCard role="alert">
          <p>{t('loadFailed')}</p>
          <div>
            <PillButton variant="outlined" onClick={retry}>
              {tl('retry')}
            </PillButton>
          </div>
        </SectionCard>
      </Shell>
    );
  }
  if (state.status === 'not-found') {
    return (
      <Shell>
        <SectionCard className="gap-3 p-6">
          <PageTitle className="text-headline">{t('notFoundTitle')}</PageTitle>
          <p className="text-t2 leading-relaxed">{t('notFoundBody')}</p>
          <BackPill href="/people">{tn('tabs.people')}</BackPill>
        </SectionCard>
      </Shell>
    );
  }

  const { conversation } = state;
  const { view, people } = conversation;
  const back = people.find((person) => person.id === from) ?? people[0];
  const span = yearSpan({ firstMessageAt: view.bounds.firstSentAt, lastMessageAt: view.bounds.lastSentAt });
  const section = back && backTo ? backTo : null;
  const backHref = back ? `/person${section ? `/${section}` : ''}?id=${encodeURIComponent(back.id)}` : '/people';
  const backLabel = back ? (section === 'highlights' ? t('backHighlights', { name: back.name }) : section === 'favorites' ? t('backFavorites', { name: back.name }) : t('back', { name: back.name })) : tn('tabs.people');

  return (
    <FeedShell>
      <header className="bg-bg z-20 flex shrink-0 flex-wrap items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <BackPill href={backHref} className="size-11 shrink-0 justify-center p-0">
          <span className="sr-only">{backLabel}</span>
        </BackPill>
        <PersonAvatar name={view.conversation.title} className="size-[42px] rounded-[14px] text-2xl" />
        <div className="min-w-0 flex-1">
          <PageTitle className="truncate text-[1.5rem] leading-[1.05]" dir="auto">
            {view.conversation.title}
          </PageTitle>
          <p className="text-mu text-xs">
            {t('messageCount', { count: view.bounds.count })}
            {span && (
              <>
                {' · '}
                <span className="whitespace-nowrap">{span}</span>
              </>
            )}
          </p>
          <p className="text-mu text-xs break-words max-sm:sr-only">
            {people.length > 0 ? t('keptUnder', { names: formatNames(people.map((person) => person.name), locale) }) : t('unassigned')}
          </p>
        </div>
        <Link
          href={`/search?conversation=${encodeURIComponent(view.conversation.id)}`}
          aria-label={t('search')}
          className="bg-sf2 text-foreground hover:bg-line focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
        >
          <Search className="size-5" aria-hidden />
        </Link>
        <ConversationNote key={view.conversation.id} conversationId={view.conversation.id} />
      </header>
      <ConversationFeed key={view.conversation.id} conversation={conversation} messageId={messageId} />
    </FeedShell>
  );
}

/** The conversation's feed: its own reads, handed to the shared body. */
function ConversationFeed({ conversation, messageId }: { conversation: OpenConversation; messageId: number | null }) {
  const t = useTranslations('conversation');
  const deps = useLibraryDeps()!;
  const { view, start } = conversation;
  const id = view.conversation.id;
  const title = view.conversation.title;
  const source = useMemo<FeedSource>(
    () => ({
      id,
      label: t('feedLabel', { title }),
      count: view.bounds.count,
      firstSentAt: view.bounds.firstSentAt,
      lastSentAt: view.bounds.lastSentAt,
      start,
      readWindow: (offset, limit) => getMessageWindow(deps, id, offset, limit),
      findOffset: (date) => findMessageOffsetByDate(deps, id, date),
      findMessageOffset: (message) => findMessageOffsetById(deps, id, message),
      listDays: () => listConversationDays(deps, id),
    }),
    [deps, id, title, view.bounds, start, t],
  );
  return <ConversationBody source={source} messageId={messageId} />;
}
