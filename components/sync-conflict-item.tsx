'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { SyncBatchOffer } from '@/components/sync-batch-offer';
import type { ConflictItem } from '@/hooks/use-sync-conflicts';
import { shortDeviceId } from '@/hooks/use-sync-device';
import type { ConflictChoice } from '@/lib/domain/sync';

const radioClass = 'accent-primary focus-visible:ring-ring/50 mt-0.5 size-5 shrink-0 outline-none focus-visible:ring-[3px]';

type Field = { key: 'name' | 'relationship' | 'description' | 'title' | 'body' | 'archived'; value: string };

/** The fields of one version that a person can compare. Every value is untrusted text. */
function fieldsOf(version: object | null | undefined): Field[] {
  if (!version) return [];
  const v = version as Record<string, unknown>;
  if (typeof v.displayName === 'string') {
    const out: Field[] = [
      { key: 'name', value: v.displayName },
      { key: 'relationship', value: String(v.relationship ?? '') },
      { key: 'description', value: String(v.description ?? '') },
    ];
    if (v.archivedAt) out.push({ key: 'archived', value: '' });
    return out;
  }
  if (typeof v.title === 'string') return [{ key: 'title', value: v.title }];
  if (typeof v.body === 'string') return [{ key: 'body', value: v.body }];
  return [];
}

const nameOf = (conflict: ConflictItem): string => {
  const pick = (version: object | null | undefined) => {
    const v = version as Record<string, unknown> | null | undefined;
    const value = v?.displayName ?? v?.title;
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  return pick(conflict.local) ?? pick(conflict.incoming) ?? '';
};

function Version({ label, fields, empty }: { label: string; fields: Field[]; empty?: string }) {
  const t = useTranslations('sync.conflicts');
  return (
    <div className="bg-bg flex min-w-0 flex-1 flex-col gap-2 rounded-[14px] p-3 text-sm">
      <h4 className="text-mu text-xs font-semibold tracking-wider uppercase">{label}</h4>
      {empty ? (
        <p className="text-t2">{empty}</p>
      ) : (
        <dl className="flex flex-col gap-2">
          {fields.map((f) => (
            <div key={f.key} className="flex min-w-0 flex-col">
              <dt className="text-t2">{t(`field.${f.key}`)}</dt>
              <dd className="flex min-w-0 flex-col items-start font-medium">
                {f.key === 'archived' ? t('archivedValue') : f.value === '' ? <span className="text-t2 font-normal">{t('nothingWritten')}</span> : <span className="break-words whitespace-pre-wrap">{f.value}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * One item to review: this device's version and the other device's, stacked on a phone and side by side from `md`; then
 * what to keep. No choice is preselected, so Apply waits until the person has picked one. An offered import undo has its own
 * actions (`SyncBatchOffer`).
 */
export function SyncConflictItem({
  conflict,
  working,
  onResolve,
}: {
  conflict: ConflictItem;
  working: boolean;
  onResolve: (choice: ConflictChoice) => void;
}) {
  const t = useTranslations('sync.conflicts');
  const [choice, setChoice] = useState<ConflictChoice>();
  const name = useId();
  const hintId = useId();
  const headingId = `sync-conflict-${conflict.id}`;
  const code = shortDeviceId(conflict.peerId);
  const batch = conflict.kind === 'batch';
  const heading = batch ? t('heading.batch', { code }) : conflict.kind === 'note' ? (conflict.noteOn ? t('heading.noteOn', { name: conflict.noteOn }) : t('heading.note')) : t(`heading.${conflict.kind}`, { name: nameOf(conflict) || t('untitled') });

  const deleted = conflict.incomingDeleted;
  const noLocal = conflict.local === null;
  const options: { value: ConflictChoice; label: string; hint?: string }[] = [
    { value: 'mine', label: noLocal ? t('choice.stayDeleted') : deleted ? t('choice.keepHere') : t('choice.mine') },
    { value: 'theirs', label: noLocal ? t('choice.bringBack') : deleted ? t('choice.deleteHere') : t('choice.theirs') },
  ];
  if (conflict.kind === 'note' && !deleted && !noLocal) options.push({ value: 'both', label: t('choice.both'), hint: t('choice.bothHint') });
  const ready = choice !== undefined;

  return (
    <SectionCard as="li" tone="sf2" className="gap-4 rounded-[22px] p-4" data-testid="sync-conflict" data-conflict-kind={conflict.kind}>
      <h3 id={headingId} tabIndex={-1} className="font-display text-name break-words outline-none">
        {heading}
      </h3>
      {batch ? (
        <SyncBatchOffer conflict={conflict} working={working} onResolve={onResolve} />
      ) : (
        <>
          <div className="flex flex-col gap-3 md:flex-row">
            <Version label={t('thisDevice')} fields={fieldsOf(conflict.local)} empty={noLocal ? t('missingHere') : undefined} />
            <Version label={t('otherDevice', { code })} fields={fieldsOf(conflict.incoming)} empty={deleted ? t('deletedThere') : undefined} />
          </div>
          <fieldset className="flex min-w-0 flex-col gap-2" disabled={working} aria-describedby={headingId}>
            <legend className="mb-1 font-medium">{t('legend')}</legend>
            {options.map((o) => (
              <label key={o.value} className="bg-bg flex min-h-11 cursor-pointer items-start gap-3 rounded-[14px] p-3 text-sm">
                <input type="radio" name={name} className={radioClass} checked={choice === o.value} onChange={() => setChoice(o.value)} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium break-words">{o.label}</span>
                  {o.hint && <span className="text-t2 leading-relaxed">{o.hint}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <div>
              <PillButton
                aria-disabled={!ready || working || undefined}
                aria-describedby={ready ? undefined : hintId}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={() => ready && !working && onResolve(choice)}
              >
                {working ? t('applying') : t('apply')}
              </PillButton>
            </div>
            {!ready && (
              <p id={hintId} className="text-t2 text-sm">
                {t('choose')}
              </p>
            )}
          </div>
        </>
      )}
    </SectionCard>
  );
}
