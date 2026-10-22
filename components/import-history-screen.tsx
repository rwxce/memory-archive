'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, FileUp, Loader, Undo2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LibraryNotice } from '@/components/library-notice';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useImportActions } from '@/hooks/use-import';
import { useImportHistory, type HistoryPaging } from '@/hooks/use-import-history';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { Link } from '@/i18n/navigation';
import type { ImportHistoryEntry } from '@/lib/usecases/import-history';
import { importProblemOf } from '@/lib/usecases/import-wizard';
import { formatWhen } from './format';

const busyClass = 'aria-disabled:pointer-events-none aria-disabled:opacity-50';
const linkClass =
  'text-primary focus-visible:ring-ring/50 inline-flex min-h-11 w-fit items-center rounded-md text-sm font-medium break-words underline underline-offset-4 outline-none focus-visible:ring-[3px]';
const backLinkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

type Panel = { id: string; status: 'confirming' | 'working' | 'busy' | 'failed' };

/**
 * What each import added, newest first, and a way to take one back. `?person=<id>` shows only the
 * imports into the conversations kept under that person (a static export has no route per id).
 * Undo is the wizard's undo: it asks first and says what goes and what stays.
 */
export function ImportHistoryScreen({ paging }: { paging?: HistoryPaging } = {}) {
  const { state, retry } = useLibrary();
  const personId = useSearchParams().get('person');
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return personId ? <PersonScope personId={personId} onRetry={retry} paging={paging} /> : <HistoryContent person={null} onRetry={retry} paging={paging} />;
}

/** Resolves the person first: an id that matches no one gets the calm "not found", never an error. */
function PersonScope({ personId, onRetry, paging }: { personId: string; onRetry: () => void; paging?: HistoryPaging }) {
  const t = useTranslations('person');
  const tl = useTranslations('library');
  const th = useTranslations('history');
  const result = usePersonDetails(personId);
  if (result.status === 'loading') {
    return (
      <Shell>
        <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
      </Shell>
    );
  }
  if (result.status === 'error') {
    return (
      <Shell>
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{th('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={onRetry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }
  if (result.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{t('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{t('notFoundBody')}</p>
          <Link href="/import/history" className={backLinkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {th('showAll')}
          </Link>
        </section>
      </Shell>
    );
  }
  const { person } = result.details;
  return <HistoryContent person={{ id: person.id, name: person.displayName }} onRetry={onRetry} paging={paging} />;
}

function HistoryContent({ person, onRetry, paging }: { person: { id: string; name: string } | null; onRetry: () => void; paging?: HistoryPaging }) {
  const t = useTranslations('history');
  const tu = useTranslations('import.undo');
  const tl = useTranslations('library');
  const locale = useLocale();
  const { state, loadingMore, loadMore } = useImportHistory(person?.id ?? null, paging);
  const actions = useImportActions();
  const [panel, setPanel] = useState<Panel>();
  const [message, setMessage] = useState('');
  const [moreFailed, setMoreFailed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const working = useRef(false);

  const focusSoon = (get: () => HTMLElement | null | undefined) => setTimeout(() => get()?.focus());

  const undo = async (entry: ImportHistoryEntry) => {
    if (working.current) return;
    working.current = true;
    setPanel({ id: entry.id, status: 'working' });
    try {
      // Resolves after the list has reloaded: the entry is gone, so the outcome takes the focus.
      const result = await actions.undo(entry.id);
      setPanel(undefined);
      setMessage(result.found ? tu('done', { count: result.removedMessages }) : tu('gone'));
      focusSoon(() => headingRef.current);
    } catch (error) {
      setPanel({ id: entry.id, status: importProblemOf(error) === 'busy' ? 'busy' : 'failed' });
    } finally {
      working.current = false;
    }
  };

  const more = async () => {
    setMoreFailed(false);
    const result = await loadMore();
    if (!result.ok) {
      // Only a read that failed is reported. A page dropped because the list changed meanwhile is not an error.
      if (!result.stale) setMoreFailed(true);
      return;
    }
    // The button may be gone now (that was the last page): focus the first new entry, or else the heading.
    focusSoon(() => (result.firstNewId ? document.getElementById(`import-entry-${result.firstNewId}`) : headingRef.current));
  };

  const title = (
    <div className="flex flex-col gap-2">
      <h1 ref={headingRef} tabIndex={-1} className="font-serif text-3xl break-words outline-none">
        {t('title')}
      </h1>
      <p className="text-muted-foreground leading-relaxed break-words">{person ? t('introPerson', { name: person.name }) : t('intro')}</p>
      {person && (
        <Link href="/import/history" className={linkClass}>
          {t('showAll')}
        </Link>
      )}
    </div>
  );
  const back = person ? (
    <Link href={`/person?id=${encodeURIComponent(person.id)}`} className={backLinkClass}>
      <ArrowLeft className="size-4" aria-hidden />
      {t('backPerson', { name: person.name })}
    </Link>
  ) : (
    <Link href="/people" className={backLinkClass}>
      <ArrowLeft className="size-4" aria-hidden />
      {t('back')}
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <Shell message={message}>
        {back}
        <LibraryNotice state={{ status: 'loading' }} onRetry={onRetry} />
      </Shell>
    );
  }
  if (state.status === 'error') {
    return (
      <Shell message={message}>
        {back}
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={onRetry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }

  const { entries, hasMore } = state;
  return (
    <Shell message={message}>
      {back}
      {title}
      {entries.length === 0 ? (
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h2 className="text-lg font-semibold break-words">{person ? t('emptyPersonTitle', { name: person.name }) : t('emptyTitle')}</h2>
          <p className="text-muted-foreground leading-relaxed break-words">{person ? t('emptyPersonBody', { name: person.name }) : t('emptyBody')}</p>
          <div>
            <Button variant="outline" asChild>
              <Link href="/import">
                <FileUp aria-hidden />
                {t('import')}
              </Link>
            </Button>
          </div>
        </section>
      ) : (
        <>
          <ul className="flex flex-col gap-4" aria-label={t('listLabel')}>
            {entries.map((entry) => (
              <Entry
                key={entry.id}
                entry={entry}
                locale={locale}
                panel={panel?.id === entry.id ? panel.status : undefined}
                onAsk={() => setPanel({ id: entry.id, status: 'confirming' })}
                onCancel={() => setPanel(undefined)}
                onConfirm={() => void undo(entry)}
              />
            ))}
          </ul>
          {moreFailed && (
            <p role="alert" className="text-destructive text-sm break-words">
              {t('loadMoreFailed')}
            </p>
          )}
          {hasMore && (
            <div>
              <Button variant="outline" className={busyClass} aria-disabled={loadingMore || undefined} onClick={() => !loadingMore && void more()}>
                {loadingMore && <Loader className="motion-safe:animate-spin" aria-hidden />}
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function Entry({
  entry,
  locale,
  panel,
  onAsk,
  onCancel,
  onConfirm,
}: {
  entry: ImportHistoryEntry;
  locale: string;
  panel: Panel['status'] | undefined;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('history');
  const tu = useTranslations('import.undo');
  const tr = useTranslations('import.result');
  const tp = useTranslations('import.problem');
  const titleId = useId();
  const undoButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const before = useRef(panel);
  const title = entry.conversationTitle ?? t('conversationGone');
  const when = formatWhen(entry.createdAt, locale);
  const open = panel !== undefined;

  // Focus follows the panel: into it when it opens, back to its button when it is dismissed.
  useEffect(() => {
    const was = before.current;
    before.current = panel;
    if (panel === 'confirming' && was === undefined) cancelButton.current?.focus();
    else if (panel === undefined && was !== undefined) undoButton.current?.focus();
  }, [panel]);

  const filedUnder =
    entry.profileIds.length === entry.profileNames.length
      ? entry.profileIds.map((id, i) => ({ id, name: entry.profileNames[i] }))
      : entry.profileNames.map((name) => ({ id: '', name }));
  const body = entry.createdConversation
    ? t('undo.bodyCreated', { count: entry.messagesPresent, title })
    :t('undo.body', { count: entry.messagesPresent });

  return (
    <li className="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={`import-entry-${entry.id}`} tabIndex={-1} className="text-base leading-snug font-semibold break-words outline-none">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm break-words">{entry.sourceLabel}</p>
        <p className="text-muted-foreground text-sm">
          <time dateTime={entry.createdAt}>{t('when', { relative: when.relative, absolute: when.absolute })}</time>
        </p>
      </div>

      <ul className="flex flex-col gap-1.5 leading-relaxed">
        <li className="font-medium">{t('added', { count: entry.messagesAdded })}</li>
        {entry.messagesSkipped > 0 && <li>{t('alreadyThere', { count: entry.messagesSkipped })}</li>}
        {entry.createdConversation && <li className="text-muted-foreground">{t('createdConversation')}</li>}
        {entry.mediaPresent > 0 && <li>{t('media', { count: entry.mediaPresent })}</li>}
        {entry.messagesPresent > 0 && entry.messagesPresent < entry.messagesAdded && (
          <li className="text-muted-foreground">{t('partlyGone', { count: entry.messagesAdded - entry.messagesPresent })}</li>
        )}
      </ul>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm">
        {filedUnder.length === 0 ? (
          <span className="text-muted-foreground">{t('unassigned')}</span>
        ) : (
          <>
            <span className="text-muted-foreground">{t('keptUnder')}</span>
            {filedUnder.map((p, i) =>
              p.id ? (
                <Link key={p.id} href={`/person?id=${encodeURIComponent(p.id)}`} className={linkClass}>
                  {p.name}
                </Link>
              ) : (
                <span key={`${p.name}-${i}`} className="break-words">
                  {p.name}
                </span>
              ),
            )}
          </>
        )}
      </div>

      {!entry.canUndo ? (
        <p className="text-muted-foreground text-sm leading-relaxed">{entry.messagesAdded === 0 ? t('nothingAdded') : t('nothingLeft')}</p>
      ) : open ? (
        <div
          role="group"
          aria-labelledby={titleId}
          className="bg-muted flex min-w-0 flex-col gap-3 rounded-lg p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && panel !== 'working') {
              event.stopPropagation();
              onCancel();
            }
          }}
        >
          <p id={titleId} className="font-semibold">
            {tu('title')}
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed break-words">{body}</p>
          <p role="alert" className="text-destructive text-sm break-words empty:hidden">
            {panel === 'busy' ? tp('busy') : panel === 'failed' ? tu('failed') : ''}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button ref={cancelButton} variant="outline" className={busyClass} aria-disabled={panel === 'working' || undefined} onClick={() => panel !== 'working' && onCancel()}>
              {tu('cancel')}
            </Button>
            <Button variant="destructive" className={busyClass} aria-disabled={panel === 'working' || undefined} onClick={() => panel !== 'working' && onConfirm()}>
              {tu('confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button ref={undoButton} variant="ghost" aria-label={tr('undoLabel', { title })} onClick={onAsk}>
            <Undo2 aria-hidden />
            {tr('undo')}
          </Button>
        </div>
      )}
    </li>
  );
}
