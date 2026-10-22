'use client';

import { useEffect, useRef, useState } from 'react';
import { FileArchive } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BackPill } from '@/components/back-pill';
import { PageTitle } from '@/components/page-title';
import { CheckStep, ConfirmStep, MeStep, PersonStep, PreviewStep } from '@/components/import-steps';
import { blockerOf, checkKey, currentCheck, STEPS, type Blocker, type FileItem, type StepId } from '@/components/import-types';
import type { ProfileFormValues } from '@/components/profile-form';
import { PillButton } from '@/components/pill-button';
import { cn } from '@/components/ui/utils';
import type { People } from '@/lib/usecases/library';
import { messagesToAdd } from '@/lib/usecases/import-wizard';

const STEP_KEYS = ['preview', 'person', 'me', 'check', 'confirm'] as const;
// aria-disabled, not disabled: a busy button keeps focus.
const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';

export interface WizardActions {
  patch(patch: Partial<FileItem>): void;
  ensurePreview(): void;
  retryPreview(): void;
  ensureCheck(): void;
  retryCheck(): void;
  createPerson(values: ProfileFormValues): Promise<string>;
  remove(): void;
  toFiles(): void;
  back(): void;
  next(): void;
}

/**
 * One screen per step for one file: a progress indicator ("Step 2 of 5") with a real heading that
 * takes focus when the step changes, the step's question, and Back / Next. What was chosen stays
 * in the file's state (the screen above owns it), so going back never loses anything. Next never
 * silently picks for the person: a missing choice is explained under the question and the focus
 * moves to it.
 */
export function ImportWizard({
  item,
  items,
  index,
  step,
  people,
  actions,
}: {
  item: FileItem;
  items: FileItem[];
  index: number;
  step: StepId;
  people: People;
  actions: WizardActions;
}) {
  const t = useTranslations('import');
  const heading = useRef<HTMLHeadingElement>(null);
  const group = useRef<HTMLFieldSetElement>(null);
  const [asked, setAsked] = useState<Blocker>();

  const { ensurePreview, ensureCheck } = actions;
  const key = checkKey(item);
  useEffect(() => heading.current?.focus(), [item.id, step]);
  useEffect(() => {
    setAsked(undefined);
  }, [item.id, step]);
  useEffect(() => {
    if (step === 1) ensurePreview();
  }, [step, item.id, ensurePreview]);
  useEffect(() => {
    if (step === 4) ensureCheck();
  }, [step, item.id, key, ensureCheck]);

  const blocker = blockerOf(item, step);
  // Shown only while it still applies: the moment the person chooses, the message goes.
  const error = asked && asked === blocker ? asked : undefined;
  const destination = item.destination;
  const personName = destination?.kind === 'person' ? destination.name : undefined;

  const others = items.filter((other) => other.id !== item.id && !other.confirmed);
  const check = currentCheck(item);
  const add = check ? messagesToAdd(check) : 0;
  const addOf = (other: FileItem) => {
    const answer = currentCheck(other);
    return answer ? messagesToAdd(answer) : 0;
  };
  const total = items.reduce((sum, other) => sum + addOf(other), 0);

  let nextLabel = t('wizard.next');
  if (step === 5) {
    if (others.length > 0) nextLabel = t('confirm.more');
    else if (items.length > 1) nextLabel = total === 0 ? t('confirm.nothing') : t('confirm.all', { count: total, files: items.length });
    else if (add === 0) nextLabel = t('confirm.nothing');
    else nextLabel = personName ? t('confirm.single', { count: add, name: personName }) : t('confirm.unassigned', { count: add });
  }

  const next = () => {
    if (blocker === 'loading') return;
    if (blocker) {
      setAsked(blocker);
      // After the message is in the DOM, the question gets the focus.
      setTimeout(() => group.current?.querySelector<HTMLElement>('input')?.focus());
      return;
    }
    actions.next();
  };

  const title = t(`steps.${STEP_KEYS[step - 1]}`);
  const first = index === 0 && step === 1;
  const words = title.split(' ');
  const tail = words.length > 1 ? words.pop() : undefined;
  const lead = words.join(' ');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <BackPill onClick={actions.toFiles}>{t('wizard.toFiles')}</BackPill>
        <span aria-hidden className="text-ac-tx text-[13px] font-semibold whitespace-nowrap">
          {t('wizard.step', { step, total: STEPS.length })}
        </span>
      </div>
      <div aria-hidden className="grid grid-cols-5 gap-1.5">
        {STEPS.map((s) => (
          <span key={s} className={cn('h-1.5 rounded-[3px]', s <= step ? 'bg-ac' : 'bg-sf2')} />
        ))}
      </div>
      <div className="bg-mint flex min-w-0 items-center gap-3 rounded-[18px] px-3.5 py-3">
        <span aria-hidden className="bg-bg flex size-10 shrink-0 items-center justify-center rounded-xl">
          <FileArchive className="text-ac-tx size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-t2 text-xs">{items.length > 1 ? t('wizard.fileChip', { index: index + 1, count: items.length }) : t('wizard.fileSingle')}</p>
          <p className="truncate text-sm font-semibold" dir="auto" title={item.file.name}>
            {item.file.name}
          </p>
        </div>
      </div>

      <PageTitle as="h2" ref={heading} tabIndex={-1} accent={tail}>
        <span className="sr-only">{t('wizard.step', { step, total: STEPS.length })}. </span>
        {lead || title}
      </PageTitle>

      {step === 1 && <PreviewStep item={item} onRetry={actions.retryPreview} onRemove={actions.remove} />}
      {step === 2 && (
        <PersonStep
          item={item}
          people={people.active}
          error={error === 'person' ? t('person.required') : undefined}
          groupRef={group}
          onChoose={(destination) => actions.patch({ destination, addingPerson: false, conversation: { mode: 'auto' }, ambiguity: undefined })}
          onAdding={(addingPerson) => actions.patch({ addingPerson })}
          onCreate={actions.createPerson}
        />
      )}
      {step === 3 && (
        <MeStep
          item={item}
          error={error === 'me' ? t('me.required') : undefined}
          groupRef={group}
          onChoose={(me) => actions.patch({ me })}
        />
      )}
      {step === 4 && (
        <CheckStep
          item={item}
          error={error}
          groupRef={group}
          onRetry={actions.retryCheck}
          onDateOrder={(dateOrder) => actions.patch({ dateOrder, conversation: { mode: 'auto' }, ambiguity: undefined })}
          onConversation={(conversation) => actions.patch({ conversation })}
        />
      )}
      {step === 5 && <ConfirmStep item={item} personName={personName} onSkipVideos={(skipVideos) => actions.patch({ skipVideos })} />}

      {step === 5 && others.length > 0 && <p className="text-mu text-sm">{t('confirm.queueNote', { files: items.length })}</p>}

      <div className="border-line bg-bg sticky bottom-0 z-10 -mx-5 mt-2 flex gap-2.5 border-t px-5 pt-3.5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 lg:bg-sf lg:-mx-12 lg:-mb-12 lg:rounded-b-[32px] lg:px-12 lg:pb-6">
        <PillButton variant="outlined" size="lg" className="flex-1" onClick={first ? actions.toFiles : actions.back}>
          {first ? t('wizard.toFiles') : t('wizard.back')}
        </PillButton>
        <PillButton size="lg" className={cn('flex-[2] whitespace-normal', busyClass)} aria-disabled={blocker === 'loading' || undefined} onClick={next}>
          {nextLabel}
        </PillButton>
      </div>
    </div>
  );
}
