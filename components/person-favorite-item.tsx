'use client';

import { FileText, Image as ImageIcon, Mic, Star, Video } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import type { PersonTimelineMessage } from '@/lib/domain/library';
import { formatDayTime } from './format';
import { isMediaMessage } from './message-media';

const KIND_ICON = { photo: ImageIcon, sticker: ImageIcon, video: Video, audio: Mic, document: FileText } as const;
const KINDS = ['photo', 'sticker', 'video', 'audio', 'document'] as const;

/** What a media favorite shows without reading its file: the kind and the file name. */
function MediaLine({ message }: { message: PersonTimelineMessage }) {
  const tm = useTranslations('conversation.media');
  const kind = KINDS.find((k) => k === message.type);
  if (!kind) return null;
  const Icon = KIND_ICON[kind];
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-sm break-words">
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
export function PersonFavoriteItem({ item, personId, onRemove }: { item: PersonTimelineMessage; personId: string; onRemove: (item: PersonTimelineMessage) => void }) {
  const t = useTranslations('personFavorites');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const author = item.isMe ? t('you') : item.participantName || t('unknownAuthor');
  const href = `/conversation?id=${encodeURIComponent(item.conversationId)}&from=${encodeURIComponent(personId)}&date=${item.sentAt.slice(0, 10)}`;
  return (
    <li className="bg-card flex flex-col gap-2 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-2">
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-pressed
          aria-label={t('remove')}
          title={t('remove')}
          onClick={() => onRemove(item)}
          className="text-primary -mt-2 -mr-2 shrink-0 rounded-full"
        >
          <Star className="fill-current" aria-hidden />
        </Button>
      </div>
      {isMediaMessage(item.type) && <MediaLine message={item} />}
      {item.body && (
        <p className="leading-relaxed break-words whitespace-pre-line" dir="auto">
          {item.body}
        </p>
      )}
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
