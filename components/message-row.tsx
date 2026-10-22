'use client';

import { memo, useId, useMemo, useState, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { ConversationMessage } from '@/lib/domain/library';
import { splitLinks } from '@/lib/usecases/message-text';
import { cn } from '@/components/ui/utils';
import { useMessageSource } from '@/hooks/use-message-source';
import { formatFullDay } from './format';
import { DetailsButton, MessageDetails } from './message-details';
import { isMediaMessage, MessageMedia } from './message-media';
import { senderHue } from './sender-color';

const day = (stamp: string) => stamp.slice(0, 10);
const time = (stamp: string) => stamp.slice(11, 16);
/** Notices from the source, shown centered and quiet instead of as a bubble. */
const isNotice = (type: string) => type === 'system' || type === 'deleted' || type === 'omitted';

/** Message text with links. Rendered as React text nodes: nothing in a message can become markup. */
function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            title={part.href}
            className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px]"
          >
            {part.label}
          </a>
        ),
      )}
    </>
  );
}

export interface MessageRowProps {
  conversationId: string;
  index: number;
  count: number;
  top: number;
  message: ConversationMessage;
  /** The message before this one, to know whether the day or the sender changed. */
  previous: ConversationMessage | null;
  rowRef: (element: HTMLElement | null) => void | (() => void);
}

const rowStyle = (top: number): CSSProperties => ({ transform: `translateY(${top}px)` });
const rowClass = 'absolute inset-x-0 top-0 px-3 py-0.5 sm:px-4';

/**
 * One message of the feed: a date separator when the day changed, then a bubble (outgoing on the
 * right, incoming on the left, author name in the author's color when the author changed) or a
 * quiet centered notice. The article carries its place in the feed and an accessible name with the
 * author and the time.
 */
export const MessageRow = memo(function MessageRow({ conversationId, index, count, top, message, previous, rowRef }: MessageRowProps) {
  const t = useTranslations('conversation');
  const locale = useLocale();
  const newDay = previous === null || day(previous.sentAt) !== day(message.sentAt);
  const when = `${formatFullDay(message.sentAt, locale)}, ${time(message.sentAt)}`;
  const notice = isNotice(message.type);
  const author = message.participantName ?? '';
  // Details open under the bubble; the row's own height change is picked up by the list's row measuring.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const source = useMessageSource(conversationId, message.id, open);

  const separator = newDay && (
    <div aria-hidden className="my-2 flex justify-center">
      <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-center text-xs">{formatFullDay(message.sentAt, locale)}</span>
    </div>
  );
  const common = { 'data-index': index, ref: rowRef, 'aria-posinset': index + 1, 'aria-setsize': count, style: rowStyle(top), className: rowClass };

  if (notice) {
    const fallback = message.type === 'deleted' ? t('deleted') : message.type === 'omitted' ? t('omitted') : '';
    return (
      <article {...common} aria-label={t('noticeLabel', { when })}>
        {separator}
        <p dir="auto" className="text-muted-foreground mx-auto max-w-[90%] text-center text-sm whitespace-pre-wrap italic [overflow-wrap:anywhere]">
          <RichText text={message.body || fallback} />
        </p>
      </article>
    );
  }

  const showAuthor = newDay || previous === null || previous.participantName !== message.participantName || isNotice(previous.type);
  const media = isMediaMessage(message.type);
  const button = <DetailsButton open={open} panelId={panelId} onToggle={() => setOpen((value) => !value)} />;
  return (
    <article {...common} aria-label={author ? t('messageLabel', { author, when }) : when}>
      {separator}
      <div className={cn('group/row flex items-center', message.isMe ? 'justify-end' : 'justify-start')}>
        {message.isMe && button}
        <div
          className={cn(
            'flex min-w-0 max-w-[85%] flex-col gap-1 rounded-lg px-2.5 py-1.5 text-sm leading-snug shadow-xs sm:max-w-[75%]',
            message.isMe ? 'bg-(--bubble-out) text-foreground' : 'bg-card text-card-foreground border',
          )}
        >
          {showAuthor && author && (
            <span dir="auto" className="sender-name text-[13px] font-semibold [overflow-wrap:anywhere]" style={{ '--sender-hue': senderHue(author) } as CSSProperties}>
              {author}
            </span>
          )}
          {media && <MessageMedia message={message} />}
          <div className="flex flex-wrap items-end justify-end gap-x-3">
            {message.body !== '' && (
              <p dir="auto" className="max-w-full min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                <RichText text={message.body} />
              </p>
            )}
            <time dateTime={message.sentAt} className="text-muted-foreground ms-auto shrink-0 text-[11px] leading-none">
              {time(message.sentAt)}
            </time>
          </div>
        </div>
        {!message.isMe && button}
      </div>
      {open && <MessageDetails id={panelId} align={message.isMe ? 'end' : 'start'} state={source.state} onRetry={source.retry} />}
    </article>
  );
});

/** A row whose messages have not arrived yet: a quiet placeholder with the estimated height. */
export const PlaceholderRow = memo(function PlaceholderRow({ index, top, rowRef }: Pick<MessageRowProps, 'index' | 'top' | 'rowRef'>) {
  return (
    <div aria-hidden data-index={index} ref={rowRef} style={{ ...rowStyle(top), height: 64 }} className={rowClass}>
      <div className="bg-muted/50 h-10 w-2/5 rounded-lg motion-safe:animate-pulse" />
    </div>
  );
});
