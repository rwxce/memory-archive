'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { ErrorNote } from '@/components/screen-states';
import { useHighlightMessages } from '@/hooks/use-highlight-messages';
import { Link } from '@/i18n/navigation';
import type { HighlightItem, HighlightMessage } from '@/lib/domain/highlights';
import { conversationHref } from './conversation-link';
import { withEmojiPresentation } from './emoji';
import { formatDay, formatDayTime } from './format';
import { isMediaMessage } from './message-media';

const linkClass = 'text-ac-tx focus-visible:ring-ring/50 -ms-2 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]';

/**
 * Asks before a highlight is deleted, in a native modal `<dialog>` (focus is trapped and returned to
 * the button that opened it, Escape cancels). Only mounted while asking, so a long list carries one.
 */
function DeleteDialog({ title, onCancel, onConfirm }: { title: string; onCancel: () => void; onConfirm: () => Promise<boolean> }) {
  const t = useTranslations('personHighlights');
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<'asking' | 'deleting' | 'failed'>('asking');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const run = async () => {
    setPhase('deleting');
    if (!(await onConfirm())) setPhase('failed');
  };
  const deleting = phase === 'deleting';

  return (
    <dialog
      ref={dialog}
      aria-labelledby="highlight-delete-title"
      aria-describedby="highlight-delete-body"
      onCancel={(event) => {
        event.preventDefault();
        if (!deleting) onCancel();
      }}
      className="bg-bg text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl p-6 shadow-soft backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id="highlight-delete-title" className="font-display text-headline">
          {t('deleteTitle')}
        </h2>
        <div id="highlight-delete-body" className="flex flex-col gap-2 text-sm">
          <p dir="auto" className="font-medium break-words">
            {title}
          </p>
          <p>{t('deleteBody')}</p>
        </div>
        <p role={phase === 'failed' ? 'alert' : 'status'} className="text-destructive min-h-5 text-sm">
          {phase === 'failed' ? t('deleteFailed') : deleting ? <span className="text-muted-foreground">{t('deleting')}</span> : null}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <PillButton variant="outlined" onClick={onCancel} disabled={deleting} autoFocus>
            {t('cancel')}
          </PillButton>
          <PillButton variant="danger" onClick={run} disabled={deleting}>
            {t('deleteConfirm')}
          </PillButton>
        </div>
      </div>
    </dialog>
  );
}

/** How many of a highlight's messages are listed before "Show all". */
const MESSAGES_PREVIEW = 3;

/** What a message shows in one line: its text, or the kind of file (and its text, if it has any). */
function MessageLine({ message }: { message: HighlightMessage }) {
  const tm = useTranslations('conversation.media');
  const kind = isMediaMessage(message.type) ? message.type : null;
  const text = withEmojiPresentation(message.body);
  return (
    <span dir="auto" className="line-clamp-1 text-[15px] break-words">
      {kind && <span className="text-mu">{tm(kind)}{text ? ' · ' : ''}</span>}
      {text}
    </span>
  );
}

/**
 * The messages of a highlight as quick links, each to that exact message: read only when opened,
 * three at first and "Show all" for the rest. Text, names and file names are only rendered as text.
 */
function HighlightMessages({ item, personId, messages }: { item: HighlightItem; personId: string; messages: HighlightMessage[] }) {
  const t = useTranslations('personHighlights');
  const locale = useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? messages : messages.slice(0, MESSAGES_PREVIEW);
  return (
    <>
      <ul aria-label={t('messagesLabel', { title: item.title })} className="flex flex-col gap-1">
        {shown.map((message) => {
          const author = message.isMe ? t('you') : message.participantName || t('unknownAuthor');
          const when = formatDayTime(message.sentAt, locale);
          return (
            <li key={message.id}>
              <Link
                href={conversationHref({ conversationId: item.conversationId, personId, sentAt: message.sentAt, messageId: message.id, back: 'highlights' })}
                aria-label={t('messageOpen', { author, when })}
                className="bg-bg hover:bg-sf2 focus-visible:ring-ring/50 flex min-h-11 min-w-0 flex-col justify-center rounded-xl px-3 py-1.5 outline-none focus-visible:ring-[3px] lg:in-data-panel:bg-sf"
              >
                <span className="text-mu min-w-0 truncate text-xs">
                  <span dir="auto" className="font-semibold">
                    {author}
                  </span>
                  {' · '}
                  <time dateTime={message.sentAt}>{when}</time>
                </span>
                <MessageLine message={message} />
              </Link>
            </li>
          );
        })}
      </ul>
      {!all && messages.length > MESSAGES_PREVIEW && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-ac-tx focus-visible:ring-ring/50 -ms-2 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {t('showAllMessages', { count: messages.length })}
        </button>
      )}
    </>
  );
}

/**
 * One highlight as a card: its title and summary, which conversation, how many messages and the day
 * of the first one, the way to that day in the conversation and a delete button that asks first.
 * Title, summary and conversation title come from a file and are only ever rendered as text.
 */
export function PersonHighlightItem({
  item,
  personId,
  onDelete,
}: {
  item: HighlightItem;
  personId: string;
  onDelete: (item: HighlightItem) => Promise<boolean>;
}) {
  const t = useTranslations('personHighlights');
  const locale = useLocale();
  const [asking, setAsking] = useState(false);
  const day = formatDay(item.firstSentAt, locale);
  const [expanded, setExpanded] = useState(false);
  const { state: messages, retry } = useHighlightMessages(item.conversationId, item.id, expanded);
  // Once its messages are known the main link goes to the first one, else to the day of the first.
  const first = messages.status === 'ready' ? messages.messages[0] : undefined;
  const href = conversationHref({ conversationId: item.conversationId, personId, sentAt: first?.sentAt ?? item.firstSentAt, messageId: first?.id, back: 'highlights' });
  const panelId = `highlight-messages-${item.conversationId}-${item.id}`;

  return (
    <li className="bg-sf flex flex-col gap-2 rounded-[20px] px-4 py-3.5 lg:in-data-panel:bg-bg">
      <div className="flex items-start gap-2">
        <h3 dir="auto" className="min-w-0 flex-1 pt-1 text-base leading-snug font-semibold break-words">
          {item.title}
        </h3>
        <button
          type="button"
          aria-label={t('deleteLabel', { title: item.title })}
          title={t('delete')}
          onClick={() => setAsking(true)}
          className="text-mu hover:bg-sf2 focus-visible:ring-ring/50 -me-2 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] [&_svg]:size-4"
        >
          <Trash2 aria-hidden />
        </button>
      </div>
      {item.summary && (
        <p dir="auto" className="text-t2 text-[15px] leading-relaxed break-words whitespace-pre-line">
          {item.summary}
        </p>
      )}
      <p className="text-mu text-sm break-words">
        <span dir="auto">{item.conversationTitle}</span>
        {' · '}
        {t('messages', { count: item.messageCount })}
        {' · '}
        <time dateTime={item.firstSentAt.slice(0, 10)}>{day}</time>
      </p>
      {item.messageCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
          className="text-foreground hover:bg-sf2 focus-visible:ring-ring/50 -ms-2 flex min-h-11 w-fit items-center gap-1.5 rounded-full px-2 text-sm font-medium outline-none focus-visible:ring-[3px] [&_svg]:size-4"
        >
          <ChevronDown aria-hidden className={expanded ? 'rotate-180' : undefined} />
          {expanded ? t('hideMessages') : t('showMessages', { count: item.messageCount })}
        </button>
      )}
      <div id={panelId} hidden={!expanded} className="flex flex-col gap-1">
        {expanded &&
          (messages.status === 'ready' ? (
            <HighlightMessages item={item} personId={personId} messages={messages.messages} />
          ) : messages.status === 'error' ? (
            <ErrorNote onRetry={retry}>{t('messagesFailed')}</ErrorNote>
          ) : (
            <p role="status" className="text-mu text-sm">
              {t('messagesLoading')}
            </p>
          ))}
      </div>
      <Link href={href} aria-label={t('openLabel', { title: item.title, when: day })} className={linkClass}>
        {t('open')}
      </Link>
      {asking && (
        <DeleteDialog
          title={item.title}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            const done = await onDelete(item);
            if (done) setAsking(false);
            return done;
          }}
        />
      )}
    </li>
  );
}
