'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { SyncConflictItem } from '@/components/sync-conflict-item';
import { conflictKeyOf, type ConflictOutcome, type SyncConflictsState, type useSyncConflicts } from '@/hooks/use-sync-conflicts';

type Conflicts = ReturnType<typeof useSyncConflicts>;

const ANNOUNCE_EVERY_MS = 1000;

const OUTCOME_KEY: Record<ConflictOutcome['kind'], string> = {
  mine: 'mine',
  theirs: 'theirs',
  both: 'both',
  undone: 'undone',
  dismissed: 'dismissed',
  'record-gone': 'recordGone',
  settled: 'settled',
  'already-gone': 'alreadyGone',
  'both-restored': 'bothRestored',
  busy: 'busy',
  'too-long': 'tooLong',
  failed: 'failed',
};

/** The latest outcome as text for the live region, changed at most once a second. */
function useAnnouncement(outcome: ConflictOutcome | undefined): { key: string; seq: number } | undefined {
  const [shown, setShown] = useState<{ seq: number; kind: ConflictOutcome['kind'] }>();
  const last = useRef(0);
  useEffect(() => {
    if (!outcome) return;
    const wait = Math.max(0, last.current + ANNOUNCE_EVERY_MS - Date.now());
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown({ seq: outcome.seq, kind: outcome.kind });
    }, wait);
    return () => clearTimeout(timer);
  }, [outcome]);
  return shown ? { key: OUTCOME_KEY[shown.kind], seq: shown.seq } : undefined;
}

/**
 * "Items to review": the crossed edits and offered import undos a merge left open (`#sync-conflicts`). Calm when there is
 * none. One polite live region says what happened; after an item is settled, focus goes to the next item or to this heading.
 */
export function SyncConflictsCard({ conflicts }: { conflicts: Conflicts }) {
  const t = useTranslations('sync.conflicts');
  const { state, outcome, working, resolve } = conflicts;
  const announced = useAnnouncement(outcome);
  const heading = useRef<HTMLParagraphElement>(null);
  const pending = useRef<{ key: string; id: number; index: number }>(undefined);
  const items = state.status === 'ready' ? state.items : undefined;

  // A refused or failed attempt leaves its item in place; focus stays with it. If the control that had it was disabled while
  // working (a radio inside the fieldset) and focus fell to the page, it returns to the item's heading.
  useEffect(() => {
    if (!outcome || (outcome.kind !== 'busy' && outcome.kind !== 'failed' && outcome.kind !== 'too-long')) return;
    const id = pending.current?.id;
    pending.current = undefined;
    if (id === undefined) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById(`sync-conflict-${id}`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [outcome]);

  // The settled item left the list: focus the one now in its place, or the card's heading when it was the last.
  useEffect(() => {
    const p = pending.current;
    if (!p || !items) return;
    if (items.some((c) => conflictKeyOf(c) === p.key)) return;
    pending.current = undefined;
    const next = items[Math.min(p.index, items.length - 1)];
    const target = next ? document.getElementById(`sync-conflict-${next.id}`) : heading.current;
    (target ?? heading.current)?.focus();
  }, [items]);

  return (
    <SectionCard id="sync-conflicts" className="gap-4 p-[18px]" aria-labelledby="sync-conflicts-title">
      <div className="flex flex-col gap-1.5">
        <Eyebrow as="h2" id="sync-conflicts-title" ref={heading} tabIndex={-1} tone="muted" className="tracking-widest outline-none">
          {t('title')}
        </Eyebrow>
        <p className="text-t2 leading-relaxed">{t('description')}</p>
      </div>
      <Body state={state} />
      {items && items.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="sync-conflict-list">
          {items.map((conflict, index) => (
            <SyncConflictItem
              key={conflictKeyOf(conflict)}
              conflict={conflict}
              working={working.has(conflict.id)}
              onResolve={(choice) => {
                pending.current = { key: conflictKeyOf(conflict), id: conflict.id, index };
                void resolve(conflict.id, choice, { key: conflict.key, detectedAt: conflict.detectedAt });
              }}
            />
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" className="text-t2 text-sm leading-relaxed empty:hidden" data-testid="sync-conflicts-status">
        {announced && <span key={announced.seq}>{t(`outcome.${announced.key}`)}</span>}
      </p>
    </SectionCard>
  );
}

function Body({ state }: { state: SyncConflictsState }) {
  const t = useTranslations('sync.conflicts');
  if (state.status === 'loading') return <p>{t('loading')}</p>;
  if (state.status === 'error') return <p role="alert">{t('failed')}</p>;
  if (state.items.length === 0) return <p data-testid="sync-conflicts-empty">{t('empty')}</p>;
  return <p className="font-medium">{t('count', { count: state.items.length })}</p>;
}
