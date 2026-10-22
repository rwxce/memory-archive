'use client';

import { NotebookPen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';

/**
 * The note button beside a bubble. It opens the note under the message (`aria-expanded`); its name
 * says whether there already is a note, and the icon is filled in the accent color then. Like the
 * star it is quiet until hovered or focused on a pointer device, but a message with a note always
 * shows it; on touch it is always there. The 44 px target does not add to the row's height.
 */
export function NoteButton({ hasNote, open, panelId, onToggle }: { hasNote: boolean; open: boolean; panelId: string; onToggle: () => void }) {
  const t = useTranslations('notes');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={hasNote ? t('editButton') : t('addButton')}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={onToggle}
      className={cn(
        'text-muted-foreground -my-2 rounded-full',
        '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 focus-visible:opacity-100',
        hasNote && 'text-primary opacity-100!',
        open && 'opacity-100!',
      )}
    >
      <NotebookPen aria-hidden className={cn(hasNote && 'fill-current/20')} />
    </Button>
  );
}
