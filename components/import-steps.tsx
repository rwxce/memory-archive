'use client';

import { useEffect, useId, useState, type Ref } from 'react';
import { AlertCircle, AlertTriangle, Loader } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Choice, ChoiceGroup } from '@/components/import-choice';
import { currentCheck, type Blocker, type FileItem } from '@/components/import-types';
import { ProfileForm, type ProfileFormValues } from '@/components/profile-form';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { Person } from '@/lib/usecases/library';
import { spaceFits, type ImportProblem } from '@/lib/usecases/import-wizard';
import { formatBytes, formatDateRange, formatDay } from './format';

const REASON_KEYS = { 'same-title': 'sameTitle', 'same-title-no-overlap': 'sameTitleNoOverlap', overlap: 'overlap' } as const;

const PROBLEM_KEYS: Record<ImportProblem | 'changed', string> = {
  'invalid-export': 'invalidExport',
  'too-big': 'tooBig',
  busy: 'busy',
  'worker-failed': 'workerFailed',
  storage: 'storage',
  other: 'other',
  changed: 'changed',
};

/** The calm, code-based explanation of a failure. The error's own message is never shown. */
export function ProblemText({ problem, reading = false }: { problem: ImportProblem | 'changed'; reading?: boolean }) {
  const t = useTranslations('import.problem');
  // Looking at a file writes nothing, so a crash then says so; a crash during the import cannot.
  return <>{t(reading && problem === 'worker-failed' ? 'readFailed' : PROBLEM_KEYS[problem])}</>;
}

function Loading({ children, detail, live = true }: { children: string; detail?: string; live?: boolean }) {
  return (
    <div className="flex flex-col gap-1 py-4">
      <p role={live ? 'status' : undefined} className="text-muted-foreground flex items-center gap-2">
        <Loader className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
        {children}
      </p>
      {detail && (
        <p aria-hidden className="text-muted-foreground pl-6 text-sm">
          {detail}
        </p>
      )}
    </div>
  );
}

function Failure({ problem, reading, children }: { problem: ImportProblem | 'changed'; reading?: boolean; children?: React.ReactNode }) {
  return (
    <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
      <p className="flex items-start gap-2 leading-relaxed break-words">
        <AlertCircle className="text-destructive mt-1 size-5 shrink-0" aria-hidden />
        <ProblemText problem={problem} reading={reading} />
      </p>
      {children && <div className="flex flex-col gap-3 sm:flex-row">{children}</div>}
    </section>
  );
}

const Notice = ({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warning' }) => (
  <p
    className={cn(
      'flex items-start gap-2 rounded-lg p-3 text-sm leading-relaxed break-words',
      tone === 'warning' ? 'border-primary/40 bg-primary/10 border' : 'bg-muted text-muted-foreground',
    )}
  >
    {tone === 'warning' && <AlertTriangle className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />}
    <span className="min-w-0">{children}</span>
  </p>
);

/** Step 1: what is in the file. */
export function PreviewStep({ item, onRetry, onRemove }: { item: FileItem; onRetry: () => void; onRemove: () => void }) {
  const t = useTranslations('import.preview');
  const locale = useLocale();
  const preview = item.preview;

  if (!preview || preview.status === 'loading') {
    const done = preview?.status === 'loading' ? preview.done : undefined;
    return <Loading detail={done ? t('progress', { count: done }) : undefined}>{t('loading')}</Loading>;
  }
  if (preview.status === 'error') {
    return (
      <Failure problem={preview.problem} reading>
        <Button variant="outline" onClick={onRetry}>
          {t('retry')}
        </Button>
        <Button variant="ghost" onClick={onRemove}>
          {t('removeFile')}
        </Button>
      </Failure>
    );
  }

  const p = preview.value;
  const kinds = (['photo', 'video', 'audio', 'sticker', 'document'] as const).filter((kind) => p.media.byKind[kind]);
  return (
    <div className="flex flex-col gap-5">
      <dl className="bg-card grid min-w-0 gap-x-6 gap-y-1 rounded-xl border p-4 sm:grid-cols-[9rem_1fr] sm:gap-y-4 sm:p-5">
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('chat')}</dt>
        <dd className="font-medium break-words">{p.chatTitle}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('type')}</dt>
        <dd>{p.isGroup ? t('group') : t('private')}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('messages')}</dt>
        <dd>{t('messageCount', { count: p.messageCount })}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('period')}</dt>
        <dd>{formatDateRange(p.firstAt, p.lastAt, locale)}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('media')}</dt>
        <dd className="flex flex-col gap-1">
          {p.media.totalCount === 0 ? (
            t('mediaNone')
          ) : (
            <>
              <span>{t('mediaTotal', { count: p.media.totalCount, size: formatBytes(p.media.totalBytes, locale) })}</span>
              <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
                {kinds.map((kind) => (
                  <li key={kind}>
                    {t(`kind.${kind}`, { count: p.media.byKind[kind]!.count })} ({formatBytes(p.media.byKind[kind]!.bytes, locale)})
                  </li>
                ))}
              </ul>
            </>
          )}
        </dd>
      </dl>
      {p.media.missing > 0 && <Notice>{t('missing', { count: p.media.missing })}</Notice>}
      {p.rawLines > 0 && <Notice>{t('rawLines', { count: p.rawLines })}</Notice>}
    </div>
  );
}

/** Step 2: who the conversation is kept under. Always an explicit choice. */
export function PersonStep({
  item,
  people,
  error,
  groupRef,
  onChoose,
  onAdding,
  onCreate,
}: {
  item: FileItem;
  people: Person[];
  error?: string;
  groupRef: Ref<HTMLFieldSetElement>;
  onChoose: (destination: NonNullable<FileItem['destination']>) => void;
  /** Opens or closes the new-person form; the earlier choice is not touched. */
  onAdding: (adding: boolean) => void;
  /** Creates the person and chooses them; resolves with their id. */
  onCreate: (values: ProfileFormValues) => Promise<string>;
}) {
  const t = useTranslations('import.person');
  const name = useId();
  const [focusId, setFocusId] = useState<string>();
  const adding = item.addingPerson === true;
  const title = item.preview?.status === 'ready' ? item.preview.value.chatTitle : item.file.name;
  const chosen = item.destination;

  // A person who was just created is in the list a moment later: their radio takes the focus.
  useEffect(() => {
    if (!focusId) return;
    const radio = document.getElementById(`${name}-${focusId}`);
    if (radio) {
      radio.focus();
      setFocusId(undefined);
    }
  }, [focusId, people, name]);

  return (
    <div className="flex flex-col gap-5">
      <ChoiceGroup legend={t('legend', { title })} hint={t('hint')} error={error} groupRef={groupRef}>
        {people.length === 0 && <Notice>{t('noOne')}</Notice>}
        {people.map((person) => (
          <Choice
            key={person.id}
            id={`${name}-${person.id}`}
            name={name}
            checked={!adding && chosen?.kind === 'person' && chosen.id === person.id}
            onSelect={() => onChoose({ kind: 'person', id: person.id, name: person.displayName })}
            label={person.displayName}
            hint={[person.relationship, t('conversations', { count: person.conversationCount })].filter(Boolean).join(' · ')}
          />
        ))}
        <Choice id={`${name}-new`} name={name} checked={adding} onSelect={() => onAdding(true)} label={t('new')} />
        {adding && (
          <div className="flex flex-col gap-3 pl-1">
            <p className="text-muted-foreground text-sm leading-relaxed">{t('newHint')}</p>
            <ProfileForm
              onSubmit={async (values) => {
                setFocusId(await onCreate(values));
              }}
              onCancel={() => {
                onAdding(false);
                // The form is gone: focus goes back to where it was opened, or to the choice that stays.
                setTimeout(() => document.getElementById(chosen?.kind === 'person' ? `${name}-${chosen.id}` : `${name}-new`)?.focus());
              }}
            />
          </div>
        )}
        <Choice
          name={name}
          checked={!adding && chosen?.kind === 'later'}
          onSelect={() => onChoose({ kind: 'later' })}
          label={t('later')}
          hint={t('laterHint')}
        />
      </ChoiceGroup>
    </div>
  );
}

/** Step 3: which author is the person. The guess is pre-selected and says so; skipping is allowed. */
export function MeStep({
  item,
  error,
  groupRef,
  onChoose,
}: {
  item: FileItem;
  error?: string;
  groupRef: Ref<HTMLFieldSetElement>;
  onChoose: (me: NonNullable<FileItem['me']>) => void;
}) {
  const t = useTranslations('import.me');
  const name = useId();
  const preview = item.preview?.status === 'ready' ? item.preview.value : undefined;
  if (!preview) return null;
  const me = item.me;

  return (
    <div className="flex flex-col gap-4">
      <ChoiceGroup legend={t('legend', { title: preview.chatTitle })} hint={t('hint')} error={error} groupRef={groupRef}>
        {preview.authors.length === 0 && <Notice>{t('noAuthors')}</Notice>}
        {preview.authors.map((author) => {
          const selected = me?.kind === 'author' && me.name === author.name;
          return (
            <Choice
              key={author.name}
              name={name}
              checked={selected}
              onSelect={() => onChoose({ kind: 'author', name: author.name })}
              label={author.name}
              hint={t('count', { count: author.messageCount })}
              badge={
                author.looksLikePhoneNumber && (
                  <span className="bg-secondary text-secondary-foreground w-fit rounded-full px-2.5 py-0.5 text-xs font-medium">
                    {t('phone')}
                  </span>
                )
              }
              note={
                item.guessedMe === author.name && (
                  <span className="text-primary text-sm font-medium break-words">{t('guess')}</span>
                )
              }
            />
          );
        })}
        <Choice
          name={name}
          checked={me?.kind === 'none'}
          onSelect={() => onChoose({ kind: 'none' })}
          label={t('none')}
          hint={t('noneHint')}
        />
      </ChoiceGroup>
      {preview.authors.some((author) => author.looksLikePhoneNumber) && <Notice>{t('phoneHint')}</Notice>}
      {preview.authorsTruncated && <Notice tone="warning">{t('truncated', { count: preview.authors.length })}</Notice>}
    </div>
  );
}

/** Step 4: what the archive already holds, and the two questions the import cannot settle alone. */
export function CheckStep({
  item,
  error,
  groupRef,
  onRetry,
  onDateOrder,
  onConversation,
}: {
  item: FileItem;
  error?: Blocker;
  groupRef: Ref<HTMLFieldSetElement>;
  onRetry: () => void;
  onDateOrder: (order: 'day-first' | 'month-first') => void;
  onConversation: (choice: FileItem['conversation']) => void;
}) {
  const t = useTranslations('import.check');
  const locale = useLocale();
  const dateName = useId();
  const chatName = useId();
  const answer = currentCheck(item);
  const state = item.check?.state;

  const date = item.dateAmbiguity;
  const dayFirst = date && formatDay(date.dayFirst, locale);
  const monthFirst = date && formatDay(date.monthFirst, locale);
  const ambiguity = item.ambiguity;
  const conversation = item.conversation;
  // The group Next focuses when it is blocked: the date question first, unless the conversation is what is missing.
  const dateGroup = date && error !== 'conversation' ? groupRef : undefined;

  return (
    <div className="flex flex-col gap-6">
      {date && (
        <ChoiceGroup
          legend={t('dateTitle')}
          hint={t('dateBody', { dayFirst: dayFirst!, monthFirst: monthFirst! })}
          error={error === 'date' ? t('dateRequired') : undefined}
          groupRef={dateGroup}
        >
          <Choice
            name={dateName}
            checked={item.dateOrder === 'day-first'}
            onSelect={() => onDateOrder('day-first')}
            label={t('dayFirst', { date: dayFirst! })}
          />
          <Choice
            name={dateName}
            checked={item.dateOrder === 'month-first'}
            onSelect={() => onDateOrder('month-first')}
            label={t('monthFirst', { date: monthFirst! })}
          />
        </ChoiceGroup>
      )}

      {ambiguity && (
        <ChoiceGroup
          legend={t('ambiguousTitle')}
          hint={t(`reason.${REASON_KEYS[ambiguity.reason]}`)}
          error={error === 'conversation' ? t('choose') : undefined}
          groupRef={dateGroup ? undefined : groupRef}
        >
          {ambiguity.candidates.map((candidate) => (
            <Choice
              key={candidate.id}
              name={chatName}
              checked={conversation.mode === 'existing' && conversation.conversationId === candidate.id}
              onSelect={() => onConversation({ mode: 'existing', conversationId: candidate.id })}
              label={t('candidate', { title: candidate.title })}
              hint={t('candidateCount', { count: candidate.messageCount })}
            />
          ))}
          <Choice
            name={chatName}
            checked={conversation.mode === 'new'}
            onSelect={() => onConversation({ mode: 'new' })}
            label={t('makeNew')}
            hint={t('makeNewHint')}
          />
        </ChoiceGroup>
      )}

      {/* One live region that is there from the start: what it holds swaps from "checking" to the answer, so the answer is announced. */}
      <div aria-live="polite" data-testid="check-live" className="flex flex-col gap-3">
        {state?.status === 'error' ? (
          <section className="bg-card flex flex-col gap-3 rounded-xl border p-5">
            <p className="flex items-start gap-2 leading-relaxed break-words">
              <AlertCircle className="text-destructive mt-1 size-5 shrink-0" aria-hidden />
              <span>
                {t('failed')} <ProblemText problem={state.problem} reading />
              </span>
            </p>
            <div>
              <Button variant="outline" onClick={onRetry}>
                {t('retry')}
              </Button>
            </div>
          </section>
        ) : !answer ? (
          // While the dates are still to be read one way, nothing is being checked.
          date && !item.dateOrder ? null : <Loading live={false}>{t('loading')}</Loading>
        ) : answer.duplicates.status === 'existing' ? (
          <section className="bg-card flex flex-col gap-2 rounded-xl border p-5">
            <h3 className="text-lg font-semibold">{t('existingTitle')}</h3>
            <p className="leading-relaxed break-words">
              {t('existingBody', { title: answer.duplicates.title, count: answer.duplicates.alreadyThere })}
            </p>
            <p className="leading-relaxed font-medium">{t('existingNew', { count: answer.duplicates.wouldAdd })}</p>
          </section>
        ) : answer.duplicates.status === 'new' ? (
          <section className="bg-card rounded-xl border p-5">
            <p className="leading-relaxed">{t('new', { count: answer.messageCount })}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Step 5: space, the "without videos" option and a summary before anything is written. */
export function ConfirmStep({
  item,
  personName,
  onSkipVideos,
}: {
  item: FileItem;
  personName: string | undefined;
  onSkipVideos: (skip: boolean) => void;
}) {
  const t = useTranslations('import.space');
  const tp = useTranslations('import.preview');
  const locale = useLocale();
  const check = currentCheck(item);
  if (!check) return null;

  const { space } = check;
  const fits = spaceFits(check, item.skipVideos);
  const withoutHelps = !item.skipVideos && space.videoBytes > 0 && space.fitsWithoutVideos === true;
  const needed = formatBytes(space.neededBytes, locale);
  const available = space.availableBytes === null ? '' : formatBytes(space.availableBytes, locale);
  const add = check.duplicates.status === 'existing' ? check.duplicates.wouldAdd : check.messageCount;
  const me = item.me?.kind === 'author' ? item.me.name : t('youNone');

  return (
    <div className="flex flex-col gap-5">
      <dl className="bg-card grid min-w-0 gap-x-6 gap-y-1 rounded-xl border p-4 sm:grid-cols-[9rem_1fr] sm:gap-y-4 sm:p-5">
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('forPerson')}</dt>
        <dd className="font-medium break-words">{personName ?? t('forNobody')}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('you')}</dt>
        <dd className="break-words">{me}</dd>
        <dt className="text-muted-foreground mt-3 text-sm first:mt-0 sm:mt-0 sm:pt-0.5">{t('add')}</dt>
        <dd>{tp('messageCount', { count: add })}</dd>
      </dl>

      {space.availableBytes === null ? (
        <Notice>{t('unknown')}</Notice>
      ) : fits === false ? (
        <Notice tone="warning">
          {t('noFit')} {t('sizes', { needed, available })}{' '}
          {withoutHelps ? t('noFitWithout') : space.videoBytes > 0 ? t('noFitEvenWithout') : t('noFitFree')}
        </Notice>
      ) : (
        <Notice>
          {t('fits')} {t('sizes', { needed, available })}
        </Notice>
      )}

      {space.videoBytes > 0 && (
        <label
          className={cn(
            'bg-card flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
            item.skipVideos && 'border-primary bg-primary/5',
          )}
        >
          <input
            type="checkbox"
            checked={item.skipVideos}
            onChange={(event) => onSkipVideos(event.target.checked)}
            className="accent-primary mt-0.5 size-5 shrink-0"
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{t('skipVideos')}</span>
            <span className="text-muted-foreground text-sm leading-relaxed break-words">
              {t('skipVideosHint', { size: formatBytes(space.videoBytes, locale) })}
            </span>
          </span>
        </label>
      )}
    </div>
  );
}
