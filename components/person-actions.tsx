'use client';

import { useEffect, useId, useRef } from 'react';
import { Archive, ArchiveRestore, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { Person } from '@/lib/usecases/library';

/** Edit, archive (asking first) and restore for one person: the same on the list and on the person's page. */
export function PersonActions({
  person,
  archived,
  busy,
  confirming,
  onEdit,
  onAskArchive,
  onCancelArchive,
  onArchive,
  onRestore,
}: {
  person: Pick<Person, 'id' | 'displayName'>;
  archived: boolean;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useTranslations('people');
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  // aria-disabled, not disabled: a busy button keeps focus (a disabled one drops it).
  const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
  const ariaBusy = busy || undefined;
  const unlessBusy = (action: () => void) => () => {
    if (!busy) action();
  };

  if (confirming) {
    return (
      <div
        role="group"
        aria-labelledby={titleId}
        className="bg-muted flex flex-col gap-3 rounded-lg p-4"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            if (!busy) onCancelArchive();
          }
        }}
      >
        <p id={titleId} className="font-semibold">
          {t('archiveConfirm.title', { name: person.displayName })}
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">{t('archiveConfirm.body', { name: person.displayName })}</p>
        {/* Same order on screen and for Tab: Cancel first (it takes focus), then Archive. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button ref={cancelRef} variant="outline" className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onCancelArchive)}>
            {t('archiveConfirm.cancel')}
          </Button>
          <Button className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onArchive)}>
            <Archive aria-hidden />
            {t('archiveConfirm.confirm')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        id={`${person.id}-edit`}
        variant="outline"
        className={busyClass}
        aria-disabled={ariaBusy}
        aria-label={t('editLabel', { name: person.displayName })}
        onClick={unlessBusy(onEdit)}
      >
        <Pencil aria-hidden />
        {t('edit')}
      </Button>
      {archived ? (
        <Button
          id={`${person.id}-restore`}
          variant="outline"
          className={busyClass}
          aria-disabled={ariaBusy}
          aria-label={t('restoreLabel', { name: person.displayName })}
          onClick={unlessBusy(onRestore)}
        >
          <ArchiveRestore aria-hidden />
          {t('restore')}
        </Button>
      ) : (
        <Button
          id={`${person.id}-archive`}
          variant="ghost"
          className={busyClass}
          aria-disabled={ariaBusy}
          aria-label={t('archiveLabel', { name: person.displayName })}
          onClick={unlessBusy(onAskArchive)}
        >
          <Archive aria-hidden />
          {t('archive')}
        </Button>
      )}
    </div>
  );
}
