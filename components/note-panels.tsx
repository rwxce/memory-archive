'use client';

import { useId, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { useNote } from '@/hooks/use-note';
import { cn } from '@/components/ui/utils';
import { NoteEditor } from './note-editor';

/** The note on a person, opened from their "..." menu; Close (or Escape) hides it again. */
export function PersonNote({ personId, onClose }: { personId: string; onClose?: () => void }) {
  const t = useTranslations('notes');
  const note = useNote({ kind: 'profile', profileId: personId }, true);
  return (
    <SectionCard tone="butter" aria-labelledby="person-note">
      <Eyebrow as="h2" tone="muted" id="person-note">
        {t('personTitle')}
      </Eyebrow>
      <NoteEditor note={note} label={t('label.profile')} autoFocus onClose={onClose} />
    </SectionCard>
  );
}

/**
 * The note on a conversation, in the header: a round button that opens the editor on its own row
 * under the header (`basis-full` in the header's wrapping row). The note is read when the screen
 * opens so the button can say whether there is one. The panel scrolls within 45% of the screen's
 * height, so the messages below stay reachable on a phone.
 */
export function ConversationNote({ conversationId }: { conversationId: string }) {
  const t = useTranslations('notes');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const note = useNote({ kind: 'conversation', conversationId }, true);
  const hasNote = note.state.status === 'ready' && note.state.note !== null;
  return (
    <>
      <button
        type="button"
        aria-label={hasNote ? t('editConversation') : t('addConversation')}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]',
          hasNote ? 'bg-butter text-foreground' : 'bg-sf2 text-foreground hover:bg-line',
        )}
      >
        <NotebookPen className="size-5" aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="bg-sf order-last max-h-[45dvh] basis-full overflow-y-auto rounded-2xl p-4">
          <NoteEditor note={note} label={t('label.conversation')} autoFocus onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/**
 * The note on one conversation, as a quiet action in that conversation's row on the person page: the
 * same text button as Rename or Move (44 px high), named after the conversation, and the editor opens
 * on its own full-width line under the actions. It reads the note when the row appears so the button
 * can say "Edit" and fill the icon when there already is one.
 */
export function ConversationRowNote({ conversationId, title }: { conversationId: string; title: string }) {
  const t = useTranslations('conversations');
  const tn = useTranslations('notes');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const note = useNote({ kind: 'conversation', conversationId }, true);
  const hasNote = note.state.status === 'ready' && note.state.note !== null;
  return (
    <>
      <button
        type="button"
        id={`${conversationId}-note`}
        aria-label={t(hasNote ? 'noteEditLabel' : 'noteAddLabel', { title })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="text-ac-tx hover:bg-sf2 focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium outline-none focus-visible:ring-[3px] [&_svg]:size-4"
      >
        <NotebookPen aria-hidden className={cn(hasNote && 'fill-current/20')} />
        {t(hasNote ? 'noteEdit' : 'noteAdd')}
      </button>
      {open && (
        <div id={panelId} className="bg-sf2 order-last mx-2 mt-1 mb-2 max-h-[45dvh] basis-full overflow-y-auto rounded-2xl p-4">
          <NoteEditor note={note} label={tn('label.conversation')} autoFocus onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
