'use client';

import { useEffect, useId, useRef } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, Loader, MinusCircle, Undo2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { percentOf, currentCheck, type FileItem, type RunState } from '@/components/import-types';
import { ProblemText } from '@/components/import-steps';
import { PillButton } from '@/components/pill-button';
import { cn } from '@/components/ui/utils';
import { Link } from '@/i18n/navigation';
import type { ImportProgress } from '@/lib/usecases/import';
import { formatBytes } from './format';

const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
const linkClass =
  'text-ac-tx focus-visible:ring-ring/50 inline-flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]';

const STATUS_ICON = {
  waiting: CircleDashed,
  running: Loader,
  done: CheckCircle2,
  failed: AlertCircle,
  cancelled: MinusCircle,
  notStarted: MinusCircle,
} as const;

/** The state of one file as a word and an icon, never as colour alone. */
function Status({ run }: { run: RunState }) {
  const t = useTranslations('import.status');
  const undone = run.status === 'done' && typeof run.undo === 'object';
  const Icon = STATUS_ICON[run.status];
  return (
    <span className="text-mu inline-flex items-center gap-1.5 text-sm">
      <Icon className={cn('size-4 shrink-0', run.status === 'running' && 'motion-safe:animate-spin')} aria-hidden />
      {t(undone ? 'undone' : run.status)}
    </span>
  );
}

function ProgressBar({ progress, label }: { progress: ImportProgress | undefined; label: string }) {
  const percent = percentOf(progress);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="bg-sf2 h-2 w-full overflow-hidden rounded-full"
    >
      <div
        className={cn('bg-primary h-full rounded-full', percent === undefined ? 'w-1/3 motion-safe:animate-pulse' : 'transition-[width] motion-reduce:transition-none')}
        style={percent === undefined ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/** While the files are imported one after the other: a queue with the state of each file and the running one's progress. */
export function ImportRunning({
  items,
  progress,
  cancelling,
  headingRef,
  onCancel,
}: {
  items: FileItem[];
  progress: ImportProgress | undefined;
  cancelling: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  onCancel: () => void;
}) {
  const t = useTranslations('import.run');
  const locale = useLocale();
  const total = items.length;
  const current = items.findIndex((item) => item.run.status === 'running');

  const phaseText = () => {
    if (!progress) return t('preparing');
    if (progress.phase === 'reading') return progress.done > 0 ? `${t('reading')} ${t('readingCount', { count: progress.done })}` : t('reading');
    if (progress.phase === 'media') {
      const bytes =
        progress.totalBytes && progress.bytes !== undefined
          ? ` · ${t('bytes', { done: formatBytes(progress.bytes, locale), total: formatBytes(progress.totalBytes, locale) })}`
          : '';
      return `${t('media')} ${t('mediaCount', { done: progress.done, total: progress.total })}${bytes}`;
    }
    return t('saving');
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 ref={headingRef} tabIndex={-1} className="font-display text-headline outline-none">
        {t('title')}
      </h2>
      {current >= 0 && (
        <section className="bg-sf lg:in-data-panel:bg-bg flex min-w-0 flex-col gap-3 rounded-3xl p-4 sm:p-5">
          {total > 1 && (
            <p className="text-mu text-sm break-words">
              {t('fileOf', { index: current + 1, count: total, name: items[current].file.name })}
            </p>
          )}
          {total === 1 && <p className="font-medium break-words">{items[current].file.name}</p>}
          <ProgressBar progress={progress} label={t('progressLabel')} />
          <p aria-hidden className="text-sm break-words">
            {cancelling ? t('cancelling') : phaseText()}
          </p>
        </section>
      )}
      {total > 1 && <Queue items={items} label={t('queue')} />}
      <p className="text-mu text-sm leading-relaxed">{t('cancelNote')} {t('keepOpen')}</p>
      <div>
        <PillButton variant="outlined" className={busyClass} aria-disabled={cancelling || undefined} onClick={() => !cancelling && onCancel()}>
          {cancelling ? t('cancelling') : t('cancel')}
        </PillButton>
      </div>
    </div>
  );
}

function Queue({ items, label }: { items: FileItem[]; label: string }) {
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="bg-sf lg:in-data-panel:bg-bg flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl p-3">
          <span className="min-w-0 text-sm font-medium break-words">{item.file.name}</span>
          <Status run={item.run} />
        </li>
      ))}
    </ul>
  );
}

/** The result of every file in plain words, with undo for the ones that were imported. */
export function ImportDone({
  items,
  headingRef,
  onUndoAsk,
  onUndoCancel,
  onUndo,
  onReview,
  onRetry,
  onAnother,
}: {
  items: FileItem[];
  headingRef: React.Ref<HTMLHeadingElement>;
  onUndoAsk: (id: string) => void;
  onUndoCancel: (id: string) => void;
  onUndo: (id: string) => void;
  onReview: (id: string) => void;
  onRetry: () => void;
  onAnother: () => void;
}) {
  const t = useTranslations('import.done');
  const cancelled = items.some((item) => item.run.status === 'cancelled' || item.run.status === 'notStarted');
  const problems = items.some((item) => item.run.status === 'failed');
  const unfinished = items.some((item) => ['failed', 'cancelled', 'notStarted'].includes(item.run.status));
  const title = cancelled ? 'titleCancelled' : problems ? 'titleProblems' : 'titleOk';

  return (
    <div className="flex flex-col gap-6">
      <h2 ref={headingRef} tabIndex={-1} className="font-display text-headline outline-none">
        {t(title)}
      </h2>
      {cancelled && <p className="text-mu leading-relaxed">{t('cancelledNote')}</p>}
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.id} className="bg-sf lg:in-data-panel:bg-bg flex min-w-0 flex-col gap-3 rounded-3xl p-4 sm:p-5">
            <FileResult
              item={item}
              onUndoAsk={() => onUndoAsk(item.id)}
              onUndoCancel={() => onUndoCancel(item.id)}
              onUndo={() => onUndo(item.id)}
              onReview={() => onReview(item.id)}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 sm:flex-row">
        {unfinished && <PillButton onClick={onRetry}>{t('retry')}</PillButton>}
        <PillButton variant="outlined" onClick={onAnother}>
          {t('another')}
        </PillButton>
        <PillButton variant="outlined" asChild>
          <Link href="/people">{t('people')}</Link>
        </PillButton>
        <PillButton variant="outlined" asChild>
          <Link href="/import/history">{t('history')}</Link>
        </PillButton>
      </div>
    </div>
  );
}

function FileResult({
  item,
  onUndoAsk,
  onUndoCancel,
  onUndo,
  onReview,
}: {
  item: FileItem;
  onUndoAsk: () => void;
  onUndoCancel: () => void;
  onUndo: () => void;
  onReview: () => void;
}) {
  const t = useTranslations('import');
  const run = item.run;
  const undoButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const undoneRef = useRef<HTMLParagraphElement>(null);
  const titleId = useId();
  const undo = run.status === 'done' ? run.undo : undefined;
  const before = useRef(undo);

  // Focus follows the panel: into it when it opens, back to its button when it is dismissed, to the outcome when it ends.
  useEffect(() => {
    const was = before.current;
    before.current = undo;
    if (undo === 'confirming') cancelRef.current?.focus();
    else if (undo === 'idle' && (was === 'confirming' || was === 'failed')) undoButton.current?.focus();
    else if ((typeof undo === 'object' || undo === 'gone') && was !== undo) undoneRef.current?.focus();
  }, [undo]);
  const undone = typeof undo === 'object' || undo === 'gone';

  const destination = item.destination;
  const person = destination?.kind === 'person' ? destination : undefined;
  const check = currentCheck(item);
  const chatTitle =
    check?.duplicates.status === 'existing'
      ? check.duplicates.title
      : item.preview?.status === 'ready'
        ? item.preview.value.chatTitle
        : item.file.name;

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 text-base leading-snug font-semibold break-words">{chatTitle}</h3>
        <Status run={run} />
      </div>
      <p className="text-mu -mt-2 text-sm break-words">{item.file.name}</p>

      {run.status === 'done' && (
        <>
          {!undone && (
          <ul className="flex flex-col gap-1.5 leading-relaxed">
            <li className="font-medium break-words">
              {person
                ? t('result.added', { count: run.result.summary.added, name: person.name })
                : t('result.addedUnassigned', { count: run.result.summary.added })}
            </li>
            {run.result.summary.alreadyThere > 0 && <li>{t('result.alreadyThere', { count: run.result.summary.alreadyThere })}</li>}
            <li className="text-mu break-words">
              {run.result.createdConversation ? t('result.created', { title: chatTitle }) : t('result.merged', { title: chatTitle })}
            </li>
            {run.result.summary.mediaAdded > 0 && <li>{t('result.media', { count: run.result.summary.mediaAdded })}</li>}
            {run.result.summary.mediaSkipped > 0 && <li>{t('result.mediaKept', { count: run.result.summary.mediaSkipped })}</li>}
            {run.result.summary.mediaMissing > 0 && <li>{t('result.mediaMissing', { count: run.result.summary.mediaMissing })}</li>}
            {run.result.summary.videosSkipped > 0 && <li>{t('result.videosSkipped', { count: run.result.summary.videosSkipped })}</li>}
            {run.result.summary.rawLines > 0 && <li>{t('result.rawLines', { count: run.result.summary.rawLines })}</li>}
            {run.result.dateFormat.ambiguous && (
              <li>{t(run.result.dateFormat.dayFirst ? 'result.dayFirst' : 'result.monthFirst')}</li>
            )}
            {run.lateCancel && <li className="text-mu">{t('result.lateCancel')}</li>}
          </ul>
          )}

          {undo === 'confirming' || undo === 'working' || undo === 'failed' ? (
            <div
              role="group"
              aria-labelledby={titleId}
              className="bg-sf2 flex min-w-0 flex-col gap-3 rounded-2xl p-4"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.nativeEvent.isComposing && undo !== 'working') {
                  event.stopPropagation();
                  onUndoCancel();
                }
              }}
            >
              <p id={titleId} className="font-semibold">
                {t('undo.title')}
              </p>
              <p className="text-mu text-sm leading-relaxed break-words">
                {run.result.createdConversation
                  ? t('undo.bodyCreated', { count: run.result.summary.added, title: chatTitle })
                  : t('undo.body', { count: run.result.summary.added })}
              </p>
              <p role="alert" className="text-destructive text-sm break-words empty:hidden">
                {undo === 'failed' ? t('undo.failed') : ''}
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <PillButton ref={cancelRef} variant="outlined" className={busyClass} aria-disabled={undo === 'working' || undefined} onClick={() => undo !== 'working' && onUndoCancel()}>
                  {t('undo.cancel')}
                </PillButton>
                <PillButton variant="danger" className={busyClass} aria-disabled={undo === 'working' || undefined} onClick={() => undo !== 'working' && onUndo()}>
                  {t('undo.confirm')}
                </PillButton>
              </div>
            </div>
          ) : typeof undo === 'object' ? (
            <p ref={undoneRef} tabIndex={-1} className="text-mu outline-none">
              {t('undo.done', { count: undo.removed })}
            </p>
          ) : undo === 'gone' ? (
            <p ref={undoneRef} tabIndex={-1} className="text-mu outline-none">
              {t('undo.gone')}
            </p>
          ) : (
            <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
              {person ? (
                <Link href={`/person?id=${encodeURIComponent(person.id)}`} className={linkClass}>
                  {t('result.openPerson', { name: person.name })}
                </Link>
              ) : (
                <Link href="/people" className={linkClass}>
                  {t('result.openPeople')}
                </Link>
              )}
              {(run.result.summary.added > 0 || run.result.createdConversation) && (
                <PillButton
                  ref={undoButton}
                  variant="ghost-link"
                  className="self-start"
                  aria-label={t('result.undoLabel', { title: chatTitle })}
                  onClick={onUndoAsk}
                >
                  <Undo2 aria-hidden />
                  {t('result.undo')}
                </PillButton>
              )}
            </div>
          )}
        </>
      )}

      {run.status === 'failed' && (
        <>
          <p role="alert" className="leading-relaxed break-words">
            <ProblemText problem={run.problem} />
          </p>
          {run.problem === 'changed' && (
            <div>
              <PillButton variant="outlined" onClick={onReview}>
                {t('problem.review')}
              </PillButton>
            </div>
          )}
        </>
      )}
    </>
  );
}
