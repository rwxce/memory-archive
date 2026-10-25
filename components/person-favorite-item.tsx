'use client';

import { FileText, Image as ImageIcon, Mic, Star, Video } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import type { PhraseTarget } from '@/hooks/use-phrase';
import type { PersonTimelineMessage } from '@/lib/domain/library';
import { conversationHref } from './conversation-link';
import { formatDayTime } from './format';
import { isMediaMessage } from './message-media';
import { PersonAvatar } from './person-avatar';
import { PhraseAction } from './phrase-action';

const KIND_ICON = { photo: ImageIcon, sticker: ImageIcon, video: Video, audio: Mic, document: FileText } as const;
const KINDS = ['photo', 'sticker', 'video', 'audio', 'document'] as const;

/** What a media favorite shows without reading its file: the kind and the file name. */
export function MediaLine({ message }: { message: PersonTimelineMessage }) {
  const tm = useTranslations('conversation.media');
  const kind = KINDS.find((k) => k === message.type);
  if (!kind) return null;
  const Icon = KIND_ICON[kind];
  return (
    <p className="text-mu flex items-center gap-2 text-sm break-words">
      <Icon className="size-4 shrink-0" aria-hidden />
      <span dir="auto">
        {tm(kind)}
        {message.mediaName && ` · ${message.mediaName}`}
      </span>
    </p>
  );
}

/**
 * One favorite message as a compact card: when, who, which conversation, the text (or the kind and
 * name of the file), a star to remove it from favorites and the way to the message. Text, names and
 * titles are untrusted and only ever rendered as text.
 */
export function PersonFavoriteItem({ item, personId, phraseTarget, onRemove }: { item: PersonTimelineMessage; personId: string; phraseTarget?: PhraseTarget; onRemove: (item: PersonTimelineMessage) => void }) {
  const t = useTranslations('personFavorites');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const author = item.isMe ? t('you') : item.participantName || t('unknownAuthor');
  const href = conversationHref({ conversationId: item.conversationId, personId, sentAt: item.sentAt, messageId: item.id, back: 'favorites' });
  return (
    <li className="bg-sf flex flex-col gap-2 rounded-[20px] px-4 py-3.5 lg:in-data-panel:bg-bg">
      <div className="flex items-center gap-2">
        <PersonAvatar name={author} size="sm" className="size-[26px] rounded-lg text-[15px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="min-w-0 truncate text-[13px]">
            <span className="font-semibold" dir="auto">
              {author}
            </span>
            <span className="text-mu text-xs" dir="auto">
              {' · '}
              {item.conversationTitle}
            </span>
          </p>
          <time dateTime={item.sentAt} className="text-mu text-xs">
            {when}
          </time>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-pressed
          aria-label={t('remove')}
          title={t('remove')}
          onClick={() => onRemove(item)}
          className="text-star -me-2 shrink-0 rounded-full"
        >
          <Star className="fill-current" aria-hidden />
        </Button>
      </div>
      {isMediaMessage(item.type) && <MediaLine message={item} />}
      {item.body && (
        <p className="text-[15px] leading-normal break-words whitespace-pre-line" dir="auto">
          {item.body}
        </p>
      )}
      {phraseTarget && (
        <div className="flex flex-col gap-1">
          <PhraseAction body={item.body} target={phraseTarget} />
        </div>
      )}
      <Link
        href={href}
        aria-label={t('openLabel', { title: item.conversationTitle, when })}
        className="text-ac-tx focus-visible:ring-ring/50 -ms-2 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]"
      >
        {t('open')}
      </Link>
    </li>
  );
}
