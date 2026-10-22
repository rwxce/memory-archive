'use client';

import { useState } from 'react';
import { FileText, Image as ImageIcon, Mic, Video } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { PillButton } from '@/components/pill-button';
import { Link } from '@/i18n/navigation';
import type { Note, NoteItem, NoteMessage } from '@/lib/domain/library';
import { useNote } from '@/hooks/use-note';
import { formatDayTime, formatWhen } from './format';
import { isMediaMessage } from './message-media';
import { NoteEditor } from './note-editor';

const KIND_ICON = { photo: ImageIcon, sticker: ImageIcon, video: Video, audio: Mic, document: FileText } as const;
const KINDS = ['photo', 'sticker', 'video', 'audio', 'document'] as const;

/** The message a note is about: its text, or the kind and name of its file. Untrusted: text only. */
function Quoted({ message }: { message: NoteMessage }) {
  const t = useTranslations('personNotes');
  const tm = useTranslations('conversation.media');
  const locale = useLocale();
  const kind = isMediaMessage(message.type) ? KINDS.find((k) => k === message.type) : undefined;
  const Icon = kind ? KIND_ICON[kind] : undefined;
  const author = message.isMe ? t('you') : message.participantName || t('unknownAuthor');
  return (
    <blockquote className="border-line flex flex-col gap-1 border-s-2 ps-3 text-sm break-words">
      <p className="text-mu">
        <time dateTime={message.sentAt}>{formatDayTime(message.sentAt, locale)}</time>
        <span dir="auto">{` · ${author}`}</span>
      </p>
      {kind && Icon && (
        <p className="text-mu flex items-center gap-2">
          <Icon className="size-4 shrink-0" aria-hidden />
          <span dir="auto">
            {tm(kind)}
            {message.mediaName && ` · ${message.mediaName}`}
          </span>
        </p>
      )}
      {message.body && (
        <p dir="auto" className="leading-relaxed whitespace-pre-wrap">
          {message.body}
        </p>
      )}
    </blockquote>
  );
}

const linkClass = 'text-ac-tx focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]';

/**
 * One note as a card: what kind it is, the note, when it was last edited, what it is about (for a
 * message note the quoted message and its conversation) and the way there. "Edit note" opens the same
 * editor as everywhere else, in place; saving updates the card, deleting takes it off the list.
 */
export function PersonNoteItem({ item, personId, onChanged }: { item: NoteItem; personId: string; onChanged: (item: NoteItem, note: Note | null) => void }) {
  const t = useTranslations('personNotes');
  const tn = useTranslations('notes');
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const note = useNote(
    item.kind === 'profile'
      ? { kind: 'profile', profileId: item.profileId ?? personId }
      : item.kind === 'conversation'
        ? { kind: 'conversation', conversationId: item.conversationId ?? '' }
        : { kind: 'message', conversationId: item.conversationId ?? '', messageId: item.message?.id ?? 0 },
    editing,
    { initial: item, onChanged: (saved) => onChanged(item, saved) },
  );
  const edited = formatWhen(item.updatedAt, locale);
  const person = `/person?id=${encodeURIComponent(personId)}`;
  const conversation = `/conversation?id=${encodeURIComponent(item.conversationId ?? '')}&from=${encodeURIComponent(personId)}`;
  const href = item.kind === 'profile' ? person : item.kind === 'conversation' ? conversation : `${conversation}&date=${(item.message?.sentAt ?? '').slice(0, 10)}`;
  const linkText = item.kind === 'profile' ? t('openPerson') : item.kind === 'conversation' ? t('openConversation') : t('openMessage');
  const about = item.kind === 'profile' ? item.profileName : item.conversationTitle;

  return (
    <li className="bg-sf flex flex-col gap-2 rounded-[20px] px-4 py-3.5 lg:in-data-panel:bg-bg">
      <div className="flex flex-col gap-1">
        <Eyebrow as="span" tone="muted">{t(`kind.${item.kind}`)}</Eyebrow>
        {about && (
          <p dir="auto" className="text-mu text-sm break-words">
            {about}
          </p>
        )}
      </div>
      {item.kind === 'message' && item.message && <Quoted message={item.message} />}
      {editing ? (
        <NoteEditor note={note} label={tn(`label.${item.kind}`)} autoFocus onClose={() => setEditing(false)} />
      ) : (
        <>
          <p dir="auto" className="leading-relaxed break-words whitespace-pre-wrap">
            {item.body}
          </p>
          <p className="text-mu text-sm">{t('edited', { relative: edited.relative, absolute: edited.absolute })}</p>
          <div className="flex flex-wrap items-center gap-x-4">
            <PillButton type="button" variant="outlined" onClick={() => setEditing(true)}>
              {t('edit')}
            </PillButton>
            <Link href={href} aria-label={t('openLabel', { what: linkText, about: about ?? '' })} className={linkClass}>
              {linkText}
            </Link>
          </div>
        </>
      )}
    </li>
  );
}
