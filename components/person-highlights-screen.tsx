'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { DeleteAllHighlights } from '@/components/delete-all-highlights';
import { FilterChip } from '@/components/filter-chip';
import { HighlightsImport } from '@/components/highlights-import';
import { LibraryNotice } from '@/components/library-notice';
import { PersonHighlightItem } from '@/components/person-highlight-item';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { ShowMore } from '@/components/show-more';
import { Shell } from '@/components/screen-shell';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { highlightKey, useDeleteAllHighlights, usePersonHighlightCounts, usePersonHighlights } from '@/hooks/use-person-highlights';
import { HIGHLIGHT_CATEGORIES, type HighlightCategory, type HighlightItem } from '@/lib/domain/highlights';
import type { ImportFindingsResult } from '@/lib/usecases/highlights';

type Filter = 'all' | HighlightCategory;

/**
 * A person's highlights: key moments, patterns and interests imported from a findings file, grouped by
 * category and in the order of their first message, 50 at a time per group with "Show more". A chip
 * row narrows the list to one category. Each highlight can be opened in its conversation (the day
 * of its first message) or deleted after asking, and "Delete all" (also after asking) clears the person's list; the list says what happened in a live region. The
 * import card sits below. The person is chosen by `?id=`. Everything from a file is shown as text.
 */
export function PersonHighlightsScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonHighlightsContent onRetry={retry} />;
}

function HighlightGroup({
  personId,
  category,
  count,
  revision,
  onDeleted,
}: {
  personId: string;
  category: HighlightCategory;
  count: number;
  revision: number;
  onDeleted: () => void;
}) {
  const t = useTranslations('personHighlights');
  const { state, loadMore, retry, remove } = usePersonHighlights(personId, category, revision);
  const onDelete = async (item: HighlightItem) => {
    const done = await remove(item);
    if (done) onDeleted();
    return done;
  };

  return (
    <section aria-labelledby={`highlights-${category}`} className="flex flex-col gap-3">
      <h2 id={`highlights-${category}`} className="font-display text-headline px-1">
        {t('groupTitle', { category: t(`category.${category}`), count })}
      </h2>
      {state.status === 'loading' ? (
        <LoadingNote>{t('loading')}</LoadingNote>
      ) : state.status === 'error' ? (
        <ErrorNote onRetry={retry}>{t('loadFailed')}</ErrorNote>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
            {state.items.map((item) => (
              <PersonHighlightItem key={highlightKey(item)} item={item} personId={personId} onDelete={onDelete} />
            ))}
          </ul>
          <ShowMore
            shown={state.items.length}
            total={state.total}
            loading={state.loadingMore}
            failed={state.moreFailed}
            onMore={loadMore}
            labels={{
              shown: t('shown', { shown: state.items.length, total: state.total }),
              moreFailed: t('moreFailed'),
              showMore: t('showMore'),
              loadingMore: t('loadingMore'),
            }}
          />
        </div>
      )}
    </section>
  );
}

function PersonHighlightsContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personHighlights');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const counts = usePersonHighlightCounts(id);
  const deleteAll = useDeleteAllHighlights(id);
  const [filter, setFilter] = useState<Filter>('all');
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  // After a delete the button that had focus is gone: move focus to the page title so it is not lost.
  useEffect(() => {
    if (focusHeading.current && heading.current) {
      focusHeading.current = false;
      heading.current.focus();
    }
  });

  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });

  if (details.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || counts.state.status === 'error') {
    return (
      <Shell back={person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : counts.retry}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (!person || counts.state.status === 'loading') {
    return (
      <Shell>
        <LoadingNote>{t('loading')}</LoadingNote>
      </Shell>
    );
  }

  const { counts: byCategory, total } = counts.state;
  const shown = filter === 'all' ? HIGHLIGHT_CATEGORIES.filter((c) => byCategory[c] > 0) : byCategory[filter] > 0 ? [filter] : [];
  const number = new Intl.NumberFormat(undefined);

  return (
    <Shell back={personBack}>
      <header className="flex items-end justify-between gap-3 px-1">
        <h1 ref={heading} tabIndex={-1} className="font-display text-display outline-none">
          {t('title')}
        </h1>
        <p className="text-mu pb-1.5 text-end text-sm break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>
      <p role="status" className="text-mu min-h-5 text-sm break-words">
        {notice}
      </p>

      {total > 0 && (
        <div role="group" aria-label={t('filtersLabel')} className="flex flex-wrap gap-2">
          <FilterChip pressed={filter === 'all'} onPressedChange={() => setFilter('all')}>
            {t('all')}
            <span className="tabular-nums opacity-70">{number.format(total)}</span>
          </FilterChip>
          {HIGHLIGHT_CATEGORIES.map((category) => (
            <FilterChip key={category} pressed={filter === category} onPressedChange={(next) => setFilter(next ? category : 'all')}>
              {t(`category.${category}`)}
              <span className="tabular-nums opacity-70">{number.format(byCategory[category])}</span>
            </FilterChip>
          ))}
        </div>
      )}

      {total === 0 ? (
        <EmptyNote>
          {t('empty', { name: person.displayName })} {t('emptyHint')}
        </EmptyNote>
      ) : shown.length === 0 ? (
        <EmptyNote>{t('emptyFiltered')}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-6">
          {shown.map((category) => (
            <HighlightGroup
              key={category}
              personId={person.id}
              category={category}
              count={byCategory[category]}
              revision={revision}
              onDeleted={() => {
                focusHeading.current = true;
                setNotice(t('deleted'));
                counts.reload();
              }}
            />
          ))}
        </div>
      )}

      {total > 0 && (
        <DeleteAllHighlights
          name={person.displayName}
          count={total}
          onConfirm={async () => {
            const deleted = await deleteAll();
            if (deleted === null) return false;
            focusHeading.current = true;
            setNotice(t('deletedAll', { count: deleted }));
            setRevision((n) => n + 1);
            counts.reload();
            return true;
          }}
        />
      )}

      <HighlightsImport
        personId={person.id}
        onImported={(result: ImportFindingsResult) => {
          setNotice(t('imported', { count: result.imported + result.updated }));
          setRevision((n) => n + 1);
          counts.reload();
        }}
      />
    </Shell>
  );
}
