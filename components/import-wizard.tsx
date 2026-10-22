'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CheckStep, ConfirmStep, MeStep, PersonStep, PreviewStep } from '@/components/import-steps';
import { blockerOf, checkKey, currentCheck, STEPS, type Blocker, type FileItem, type StepId } from '@/components/import-types';
import type { ProfileFormValues } from '@/components/profile-form';
import { Button } from '@/components/ui/button';
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-3">
        {items.length > 1 && (
          <p className="text-muted-foreground text-sm break-words">
            {t('wizard.fileOf', { index: index + 1, count: items.length, name: item.file.name })}
          </p>
        )}
        <div aria-hidden className="flex gap-1.5">
          {STEPS.map((s) => (
            <span key={s} className={cn('h-1.5 flex-1 rounded-full', s <= step ? 'bg-primary' : 'bg-muted')} />
          ))}
        </div>
        <h2 ref={heading} tabIndex={-1} className="font-serif text-2xl leading-tight outline-none">
          <span className="text-muted-foreground block font-sans text-sm font-normal">
            {t('wizard.step', { step, total: STEPS.length })}
          </span>
          {title}
        </h2>
      </header>

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

      {step === 5 && others.length > 0 && (
        <p className="text-muted-foreground text-sm">{t('confirm.queueNote', { files: items.length })}</p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={first ? actions.toFiles : actions.back}>
          <ArrowLeft aria-hidden />
          {first ? t('wizard.toFiles') : t('wizard.back')}
        </Button>
        <Button className={busyClass} aria-disabled={blocker === 'loading' || undefined} onClick={next}>
          {nextLabel}
          {step < 5 && <ArrowRight aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
