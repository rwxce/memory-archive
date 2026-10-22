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
