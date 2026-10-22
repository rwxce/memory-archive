'use client';

import { memo, useId, useMemo, useState, type CSSProperties } from 'react';
import { MessagesSquare, NotebookText } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { ConversationMessage } from '@/lib/domain/library';
import { splitLinks } from '@/lib/usecases/message-text';
import { cn } from '@/components/ui/utils';
import { useMessageSource } from '@/hooks/use-message-source';
import { useNote } from '@/hooks/use-note';
import { FavoriteButton } from './favorite-button';
import { formatFullDay } from './format';
import { DetailsButton, MessageDetails } from './message-details';
import { isMediaMessage, MessageMedia } from './message-media';
import { NoteButton } from './note-button';
import { NoteEditor } from './note-editor';
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
  /** On a person's timeline: the conversation this message comes from, when it differs from the row before. */
  conversationTitle?: string;
  conversationHref?: string;
  rowRef: (element: HTMLElement | null) => void | (() => void);
  /** The star was pressed on a message (not offered on notices). */
  onToggleFavorite?: (message: ConversationMessage) => void;
  /** Unsaved note text by `conversationId:messageId`; a row that remounts opens its note again when it has a draft. */
  noteDrafts?: Map<string, string>;
  /** A note was saved or deleted on a message: patch `hasNote` in the cache. */
  onNoteChanged?: (message: ConversationMessage, hasNote: boolean) => void;
}

const rowStyle = (top: number): CSSProperties => ({ transform: `translateY(${top}px)` });
const rowClass = 'absolute inset-x-0 top-0 px-3 py-0.5 sm:px-4';

/**
 * One message of the feed: a date separator when the day changed, then a bubble (outgoing on the
 * right, incoming on the left, author name in the author's color when the author changed) or a
 * quiet centered notice. The article carries its place in the feed and an accessible name with the
 * author and the time.
 */
export const MessageRow = memo(function MessageRow({ conversationId, index, count, top, message, previous, conversationTitle, conversationHref, rowRef, onToggleFavorite, noteDrafts, onNoteChanged }: MessageRowProps) {
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
  const draftKey = `${conversationId}:${message.id}`;
  const [noteOpen, setNoteOpen] = useState(() => noteDrafts?.has(draftKey) ?? false);
  const notePanelId = useId();
  const note = useNote({ kind: 'message', conversationId, messageId: message.id }, noteOpen, {
    onChanged: (saved) => onNoteChanged?.(message, saved !== null),
  });

  const separator = newDay && (
    <div aria-hidden className="mt-3.5 mb-2.5 flex justify-center">
      <span className="font-display bg-sf text-t2 rounded-full px-3.5 py-1.5 text-center text-[17px] italic">{formatFullDay(message.sentAt, locale)}</span>
    </div>
  );
  const fromConversation = conversationTitle !== undefined && conversationHref !== undefined && (
    <Link
      href={conversationHref}
      className="bg-sf2 text-foreground hover:bg-line focus-visible:ring-ring/50 mx-auto mt-2 mb-1 flex min-h-11 w-fit max-w-full items-center gap-1.5 rounded-full px-3 text-xs outline-none focus-visible:ring-[3px]"
    >
      <MessagesSquare className="size-3.5 shrink-0" aria-hidden />
      <span dir="auto" className="min-w-0 truncate">{conversationTitle}</span>
      <span className="sr-only">{t('openFromTimeline')}</span>
    </Link>
  );
  const common = { 'data-index': index, ref: rowRef, 'aria-posinset': index + 1, 'aria-setsize': count, style: rowStyle(top), className: rowClass };

  if (notice) {
    const fallback = message.type === 'deleted' ? t('deleted') : message.type === 'omitted' ? t('omitted') : '';
    return (
      <article {...common} aria-label={t('noticeLabel', { when })}>
        {separator}
      {fromConversation}
        <p dir="auto" className="text-mu mx-auto max-w-[90%] py-1.5 text-center text-[13px] whitespace-pre-wrap italic [overflow-wrap:anywhere]">
          <RichText text={message.body || fallback} />
        </p>
      </article>
    );
  }

  const showAuthor = newDay || previous === null || previous.participantName !== message.participantName || isNotice(previous.type);
  const media = isMediaMessage(message.type);
  const button = (
    <div className="flex shrink-0 items-center">
      {onToggleFavorite && <FavoriteButton favorite={message.isFavorite} onToggle={() => onToggleFavorite(message)} />}
      {onNoteChanged && <NoteButton hasNote={message.hasNote} open={noteOpen} panelId={notePanelId} onToggle={() => setNoteOpen((value) => !value)} />}
      <DetailsButton open={open} panelId={panelId} onToggle={() => setOpen((value) => !value)} />
    </div>
  );
  return (
    <article {...common} aria-label={author ? t('messageLabel', { author, when }) : when}>
      {separator}
      {fromConversation}
      <div className={cn('group/row flex items-center', message.isMe ? 'justify-end' : 'justify-start')}>
        {message.isMe && button}
        <div
          className={cn(
            'flex min-w-0 max-w-[85%] flex-col gap-1 text-[15px] leading-[1.45] sm:max-w-[75%]',
            media ? 'p-1.5' : 'px-3.5 py-2.5',
            message.isMe ? 'bg-out-b text-out-ink rounded-[22px_22px_6px_22px] [&_time]:text-out-mu' : 'bg-in-b text-foreground rounded-[22px_22px_22px_6px]',
          )}
        >
          {showAuthor && author && !message.isMe && (
            <span dir="auto" className={cn('sender-name text-[13px] font-semibold [overflow-wrap:anywhere]', media && 'px-2 pt-1')} style={{ '--sender-hue': senderHue(author) } as CSSProperties}>
              {author}
            </span>
          )}
          {media && <MessageMedia message={message} />}
          <div className={cn('flex flex-wrap items-end justify-end gap-x-3', media && 'px-2 pb-0.5')}>
            {message.body !== '' && (
              <p dir="auto" className="max-w-full min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                <RichText text={message.body} />
              </p>
            )}
            {message.hasNote && (
              // The note button beside the bubble is the control; this badge only shows there is one.
              <span aria-hidden className="bg-butter text-ink ms-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-none font-semibold">
                <NotebookText className="size-3" />
                {t('noteBadge')}
              </span>
            )}
            <time dateTime={message.sentAt} className={cn('text-mu shrink-0 text-[11px] leading-none', !message.hasNote && 'ms-auto')}>
              {time(message.sentAt)}
            </time>
          </div>
        </div>
        {!message.isMe && button}
      </div>
      {noteOpen && onNoteChanged && (
        <div id={notePanelId} className="bg-sf mt-1 rounded-2xl p-4">
          <NoteEditor
            note={note}
            label={t('noteLabel')}
            autoFocus
            initialDraft={noteDrafts?.get(draftKey)}
            onDraftChange={(draft) => (draft === undefined ? noteDrafts?.delete(draftKey) : noteDrafts?.set(draftKey, draft))}
            onClose={() => setNoteOpen(false)}
          />
        </div>
      )}
      {open && <MessageDetails id={panelId} align={message.isMe ? 'end' : 'start'} state={source.state} onRetry={source.retry} />}
    </article>
  );
});

/** A row whose messages have not arrived yet: a quiet placeholder with the estimated height. */
export const PlaceholderRow = memo(function PlaceholderRow({ index, top, rowRef }: Pick<MessageRowProps, 'index' | 'top' | 'rowRef'>) {
  return (
    <div aria-hidden data-index={index} ref={rowRef} style={{ ...rowStyle(top), height: 64 }} className={rowClass}>
      <div className="bg-sf h-10 w-2/5 rounded-[22px] motion-safe:animate-pulse" />
    </div>
  );
});
