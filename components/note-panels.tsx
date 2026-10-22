'use client';

import { useId, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useNote } from '@/hooks/use-note';
import { NoteEditor } from './note-editor';

/** The note on a person, always open on their page. */
export function PersonNote({ personId }: { personId: string }) {
  const t = useTranslations('notes');
  const note = useNote({ kind: 'profile', profileId: personId }, true);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="person-note">
      <h2 id="person-note" className="text-xl font-semibold">
        {t('personTitle')}
      </h2>
      <NoteEditor note={note} label={t('label.profile')} />
    </section>
  );
}

/**
 * The note on a conversation, under its title: a button that opens the editor. The note is read
 * when the screen opens so the button can say whether there is one. The panel scrolls within half of
 * the screen's height, so the messages below stay reachable on a phone.
 */
export function ConversationNote({ conversationId }: { conversationId: string }) {
  const t = useTranslations('notes');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const note = useNote({ kind: 'conversation', conversationId }, true);
  const hasNote = note.state.status === 'ready' && note.state.note !== null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="w-fit"
      >
        <NotebookPen aria-hidden className={hasNote ? 'text-primary' : undefined} />
        {hasNote ? t('editConversation') : t('addConversation')}
      </Button>
      {open && (
        <div id={panelId} className="bg-muted/60 max-h-[45dvh] overflow-y-auto rounded-lg p-3">
          <NoteEditor note={note} label={t('label.conversation')} autoFocus onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
