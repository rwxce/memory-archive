'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { SearchResult } from '@/lib/domain/library';
import { conversationHref } from './conversation-link';
import { formatDay } from './format';
import { isMediaMessage } from './message-media';
import { PersonAvatar } from './person-avatar';
import { MediaLine } from './person-favorite-item';
import { Highlighted } from './search-highlight';

/**
 * One hit as a card that is itself the link to its conversation (at that day; `personId` keeps the
 * way back to the person when the search was scoped to one): the sender with their avatar, the
 * conversation, the day, and the matching snippet with the words marked. Text, names and titles are
 * untrusted: text only.
 */
export function SearchResultItem({ item, personId }: { item: SearchResult; personId: string | null }) {
  const t = useTranslations('search');
  const locale = useLocale();
  const author = item.isMe ? t('you') : item.participantName || t('unknownAuthor');
  const href = conversationHref({ conversationId: item.conversationId, personId, sentAt: item.sentAt, messageId: item.id });
  return (
    <li>
      <Link
        href={href}
        className="bg-sf hover:bg-sf2 focus-visible:ring-ring/50 flex min-h-11 flex-col gap-2 rounded-[20px] px-4 py-3.5 outline-none focus-visible:ring-[3px] lg:in-data-panel:bg-bg lg:in-data-panel:hover:bg-sf2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <PersonAvatar name={author} size="sm" className="size-[26px] rounded-lg text-[15px]" />
          <span className="shrink-0 text-[13px] font-semibold" dir="auto">
            {author}
          </span>
          <span className="text-mu min-w-0 truncate text-xs" dir="auto">
            {'· '}
            {item.conversationTitle}
          </span>
          <time dateTime={item.sentAt} className="text-mu ms-auto shrink-0 ps-2 text-xs">
            {formatDay(item.sentAt, locale)}
          </time>
        </span>
        {isMediaMessage(item.type) && <MediaLine message={item} />}
        <span className="block text-[15px] leading-normal break-words whitespace-pre-line" dir="auto">
          <Highlighted text={item.snippet.text} ranges={item.snippet.ranges} />
        </span>
      </Link>
    </li>
  );
}
