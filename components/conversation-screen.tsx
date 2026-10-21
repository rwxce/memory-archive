'use client';

import { ArrowLeft } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { ConversationBody } from '@/components/conversation-body';
import { LibraryNotice } from '@/components/library-notice';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { isDateParam, useConversation } from '@/hooks/use-conversation';
import { useLibrary } from '@/hooks/use-library';
import { Link } from '@/i18n/navigation';
import { formatDateRange, formatNames } from './format';

const backLinkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

/**
 * One conversation: its title, who it is kept under, how many messages and from when to when, and
 * the virtualized message feed. The conversation is chosen by `?id=` (a static export has no
 * dynamic routes); `?date=YYYY-MM-DD` opens at that day and `?from=` is the person to go back to.
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
  const tp = useTranslations('person');
  const locale = useLocale();
  const params = useSearchParams();
  const id = params.get('id');
  const date = params.get('date');
  const from = params.get('from');
  const { state, findOffset, retry } = useConversation(id, isDateParam(date) ? date : null);

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
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={retry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }
  if (state.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{t('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{t('notFoundBody')}</p>
          <Link href="/people" className={backLinkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {tp('back')}
          </Link>
        </section>
      </Shell>
    );
  }

  const { conversation } = state;
  const { view, people } = conversation;
  const back = people.find((person) => person.id === from) ?? people[0];
  const dates = formatDateRange(view.bounds.firstSentAt, view.bounds.lastSentAt, locale);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex shrink-0 flex-col gap-1 px-3 pt-2 pb-2 sm:px-4">
        <Link href={back ? `/person?id=${encodeURIComponent(back.id)}` : '/people'} className={backLinkClass}>
          <ArrowLeft className="size-4" aria-hidden />
          {back ? t('back', { name: back.name }) : tp('back')}
        </Link>
        <h1 className="font-serif text-2xl leading-tight break-words">{view.conversation.title}</h1>
        <p className="text-muted-foreground text-sm">
          {t('messageCount', { count: view.bounds.count })}
          {dates && ` · ${dates}`}
        </p>
        <p className="text-muted-foreground text-sm break-words">
          {people.length > 0 ? t('keptUnder', { names: formatNames(people.map((person) => person.name), locale) }) : t('unassigned')}
        </p>
      </header>
      <ConversationBody key={view.conversation.id} conversation={conversation} findOffset={findOffset} />
    </div>
  );
}
