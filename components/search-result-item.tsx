'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { SearchResult } from '@/lib/domain/library';
import { formatDayTime } from './format';
import { isMediaMessage } from './message-media';
import { MediaLine } from './person-favorite-item';
import { Highlighted } from './search-highlight';

/**
 * One hit as a compact card: when, who, which conversation, the matching snippet with the words
 * marked, and the way to the conversation (at that day; `personId` keeps the way back to the
 * person when the search was scoped to one). Text, names and titles are untrusted: text only.
 */
export function SearchResultItem({ item, personId }: { item: SearchResult; personId: string | null }) {
  const t = useTranslations('search');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const author = item.isMe ? t('you') : item.participantName || t('unknownAuthor');
  const from = personId ? `&from=${encodeURIComponent(personId)}` : '';
  const href = `/conversation?id=${encodeURIComponent(item.conversationId)}${from}&date=${item.sentAt.slice(0, 10)}`;
  return (
    <li className="bg-card flex flex-col gap-2 rounded-xl border p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm break-words">
          <time dateTime={item.sentAt} className="font-medium">
            {when}
          </time>
          <span className="text-muted-foreground" dir="auto">
            {' · '}
            {author}
          </span>
        </p>
        <p className="text-muted-foreground text-sm break-words" dir="auto">
          {item.conversationTitle}
        </p>
      </div>
      {isMediaMessage(item.type) && <MediaLine message={item} />}
      <p className="leading-relaxed break-words whitespace-pre-line" dir="auto">
        <Highlighted text={item.snippet.text} ranges={item.snippet.ranges} />
      </p>
      <Link
        href={href}
        aria-label={t('openLabel', { title: item.conversationTitle, when })}
        className="text-primary focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-md text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
      >
        {t('open')}
      </Link>
    </li>
  );
}
