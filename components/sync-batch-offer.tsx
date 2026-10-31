'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { shortDeviceId } from '@/hooks/use-sync-device';
import type { ConflictItem } from '@/hooks/use-sync-conflicts';

const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

/**
 * Another device undid an import this device may also have. Nothing was removed: the person can undo it here (after a
 * question that names the conversation and the number of messages, and says what happens to media), keep it, or, when
 * this device does not have that import, close the note. The names are text from the archive and are only rendered as text.
 */
export function SyncBatchOffer({
  conflict,
  working,
  onResolve,
}: {
  conflict: ConflictItem;
  working: boolean;
  onResolve: (choice: 'mine' | 'theirs') => void;
}) {
  const tb = useTranslations('sync.conflicts.batch');
  const [asking, setAsking] = useState(false);
  const titleId = useId();
  const undoButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  const code = shortDeviceId(conflict.peerId);
  const batch = conflict.batch;
  const name = batch?.title ?? tb('thisConversation');

  // Focus follows the question: into it when it opens, back to its button when it is dismissed.
  useEffect(() => {
    if (asking && !was.current) cancelButton.current?.focus();
    else if (!asking && was.current) undoButton.current?.focus();
    was.current = asking;
  }, [asking]);

  if (!conflict.matched) {
    return (
      <div className="flex flex-col gap-3">
        <p className="leading-relaxed">{tb('unmatched')}</p>
        <div>
          <PillButton variant="outlined" aria-disabled={working || undefined} className={busyClass} onClick={() => !working && onResolve('mine')}>
            {tb('close')}
          </PillButton>
        </div>
      </div>
    );
  }

  // The conversation goes only when the undo leaves it empty: say so as a fact only when every message in it is from this import.
  const removesConversation = batch?.createdConversation === true && batch.conversationMessages === batch.messages;
  const body = !batch
    ? tb('confirmBodyUnknown')
    : removesConversation
      ? tb('confirmBodyCreated', { count: batch.messages, title: name })
      : batch.createdConversation
        ? tb('confirmBodyMaybeCreated', { count: batch.messages, title: name })
        : tb('confirmBody', { count: batch.messages, title: name });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 leading-relaxed">
        <p className="break-words">{batch ? tb('offer', { code, title: name }) : tb('offerUnknown', { code })}</p>
        {batch && <p className="text-t2 text-sm">{tb('offerCount', { count: batch.messages })}</p>}
      </div>
      {asking ? (
        <div
          role="group"
          aria-labelledby={titleId}
          className="bg-sf2 flex min-w-0 flex-col gap-3 rounded-2xl p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && !working) {
              event.stopPropagation();
              setAsking(false);
            }
          }}
        >
          <p id={titleId} className="font-semibold">
            {tb('confirmTitle')}
          </p>
          <p className="text-mu text-sm leading-relaxed break-words">{body}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <PillButton ref={cancelButton} variant="outlined" className={busyClass} aria-disabled={working || undefined} onClick={() => !working && setAsking(false)}>
              {tb('cancel')}
            </PillButton>
            <PillButton variant="danger" className={busyClass} aria-disabled={working || undefined} onClick={() => !working && onResolve('theirs')}>
              {tb('confirm')}
            </PillButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row">
          <PillButton ref={undoButton} variant="outlined" className={busyClass} aria-disabled={working || undefined} onClick={() => !working && setAsking(true)}>
            <Undo2 aria-hidden />
            {tb('undo')}
          </PillButton>
          <PillButton variant="outlined" className={busyClass} aria-disabled={working || undefined} onClick={() => !working && onResolve('mine')}>
            {tb('keep')}
          </PillButton>
        </div>
      )}
    </div>
  );
}
