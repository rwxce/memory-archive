'use client';

import { useEffect, useId, useRef } from 'react';
import { Archive } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionCard } from '@/components/section-card';
import { Button } from '@/components/ui/button';
import type { Person } from '@/lib/usecases/library';

/**
 * The question before archiving a person. Archiving is asked first because it hides them from the
 * list; the choice lives in the person's "..." menu, this card appears under the header.
 * Cancel takes focus (the safe choice); Escape cancels.
 */
export function ArchiveConfirm({
  person,
  busy,
  onCancel,
  onArchive,
}: {
  person: Pick<Person, 'id' | 'displayName'>;
  busy: boolean;
  onCancel: () => void;
  onArchive: () => void;
}) {
  const t = useTranslations('people');
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  // aria-disabled, not disabled: a busy button keeps focus (a disabled one drops it).
  const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
  const ariaBusy = busy || undefined;
  const unlessBusy = (action: () => void) => () => {
    if (!busy) action();
  };

  return (
    <SectionCard
      as="div"
      tone="peach"
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          if (!busy) onCancel();
        }
      }}
    >
      <p id={titleId} className="font-display text-name break-words">
        {t('archiveConfirm.title', { name: person.displayName })}
      </p>
      <p className="text-t2 text-sm leading-relaxed break-words">{t('archiveConfirm.body', { name: person.displayName })}</p>
      {/* Same order on screen and for Tab: Cancel first (it takes focus), then Archive. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button ref={cancelRef} variant="outline" className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onCancel)}>
          {t('archiveConfirm.cancel')}
        </Button>
        <Button className={busyClass} aria-disabled={ariaBusy} onClick={unlessBusy(onArchive)}>
          <Archive aria-hidden />
          {t('archiveConfirm.confirm')}
        </Button>
      </div>
    </SectionCard>
  );
}
