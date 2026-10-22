'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { FilterChip } from '@/components/filter-chip';
import { LibraryNotice } from '@/components/library-notice';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { ErrorNote } from '@/components/screen-states';
import { Shell } from '@/components/screen-shell';
import { SearchIndexProgress } from '@/components/search-index-progress';
import { SearchResultItem } from '@/components/search-result-item';
import { ShowMore } from '@/components/show-more';
import { useLibrary } from '@/hooks/use-library';
import { usePeople } from '@/hooks/use-people';
import { isSearchable, useSearch, useSearchInput } from '@/hooks/use-search';
import { useSearchIndex } from '@/hooks/use-search-index';
import { useSearchScope, type SearchScopeState } from '@/hooks/use-search-scope';
import { MAX_QUERY_CHARS } from '@/lib/domain/search-query';

/**
 * Search over message text and file names, in everything (`/search`), in one person's conversations
 * (`?person=`) or in one conversation (`?conversation=`); `?q=` is the first query. Typing waits for
 * a pause, Enter searches at once, answers that arrive late are dropped, results come 50 at a time.
 * The index it needs is prepared when the screen opens, with progress and a Cancel. Messages and
 * names are untrusted: they are only ever rendered as text, the matches in `<mark>`.
 */
export function SearchScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <SearchContent />;
}

function SearchContent() {
  const t = useTranslations('search');
  const params = useSearchParams();
  const urlPerson = params.get('person');
  const urlConversation = params.get('conversation');
  // The scope is set in place by the chips; the address starts it and a link to another scope resets it.
  const [scopeIds, setScopeIds] = useState({ person: urlPerson, conversation: urlConversation });
  useEffect(() => setScopeIds({ person: urlPerson, conversation: urlConversation }), [urlPerson, urlConversation]);
  const { state: scope, retry: retryScope } = useSearchScope(scopeIds.person, scopeIds.conversation);

  const choose = useCallback((next: { person: string | null; conversation: string | null }) => {
    setScopeIds(next);
    // Keep the address in step with the scope (replace, so Back leaves the screen, not each chip).
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(next)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, []);

  if (scope.status === 'not-found') {
    return (
      <Shell>
        <SectionCard>
          <h1 className="font-display text-headline text-balance">{t('notFoundTitle')}</h1>
          <p className="text-t2 leading-relaxed">{t('notFoundBody')}</p>
          <div>
            <PillButton variant="outlined" onClick={() => choose({ person: null, conversation: null })}>
              {t('everyone')}
            </PillButton>
          </div>
        </SectionCard>
      </Shell>
    );
  }
  if (scope.status === 'error') {
    return (
      <Shell>
        <ErrorNote onRetry={retryScope}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  return <SearchPanel scope={scope} initialQuery={params.get('q') ?? ''} onScope={choose} />;
}

/** "Everyone" plus the active people, and the conversation in scope (removable): where the search looks. */
function ScopeChips({
  scope,
  onScope,
}: {
  scope: Exclude<SearchScopeState, { status: 'not-found' | 'error' }>;
  onScope: (next: { person: string | null; conversation: string | null }) => void;
}) {
  const t = useTranslations('search');
  const people = usePeople();
  const active = people.status === 'ready' ? people.people.active : [];
  const ready = scope.status === 'ready';
  const personId = ready && scope.kind === 'person' ? scope.id : null;
  // An archived person can still be the scope (a link from their page): their chip stays.
  const extra = ready && scope.kind === 'person' && !active.some((p) => p.id === scope.id) ? [{ id: scope.id!, displayName: scope.label ?? '' }] : [];
  return (
    <div role="group" aria-label={t('scopeLabel')} className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0 [&>*]:shrink-0">
      <FilterChip pressed={ready && scope.kind === 'all'} onPressedChange={() => onScope({ person: null, conversation: null })}>
        {t('everyone')}
      </FilterChip>
      {ready && scope.kind === 'conversation' && (
        <FilterChip pressed onPressedChange={() => onScope({ person: null, conversation: null })} aria-label={t('removeScope', { title: scope.label ?? '' })} className="max-w-64">
          <span className="truncate" dir="auto">
            {scope.label}
          </span>
          <X aria-hidden />
        </FilterChip>
      )}
      {[...extra, ...active].map((person) => (
        <FilterChip key={person.id} pressed={personId === person.id} onPressedChange={() => onScope({ person: person.id, conversation: null })} className="max-w-64">
          <span className="truncate" dir="auto">
            {person.displayName}
          </span>
        </FilterChip>
      ))}
    </div>
  );
}

function SearchPanel({
  scope,
  initialQuery,
  onScope,
}: {
  scope: Exclude<SearchScopeState, { status: 'not-found' | 'error' }>;
  initialQuery: string;
  onScope: (next: { person: string | null; conversation: string | null }) => void;
}) {
  const t = useTranslations('search');
  const { input, setInput, query, commit } = useSearchInput(initialQuery.slice(0, MAX_QUERY_CHARS));
  const index = useSearchIndex();
  const ready = scope.status === 'ready';
  const { state: results, loadMore, retry } = useSearch(ready ? scope.scope : undefined, query, ready && index.state.status === 'ready');
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus where a keyboard is the usual way in; on a phone it would only cover the page.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  // Keep the address in step with the query (replace, so Back leaves the screen, not each word).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [query]);

  const searchable = isSearchable(query);
  const searching = results.status === 'searching' || (results.status === 'ready' && results.refreshing);
  const status =
    index.state.status !== 'ready' || !searchable
      ? ''
      : searching
        ? t('searching')
        : results.status === 'ready'
          ? results.items.length === 0
            ? t('noResultsShort')
            : t(results.hasMore ? 'resultsMore' : 'results', { count: results.items.length })
          : '';

  return (
    <Shell>
      <h1 className="font-display text-display">{t('title')}</h1>

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
        className="bg-sf lg:bg-bg border-ac relative flex h-14 items-center rounded-[18px] border-2 border-transparent focus-within:border-ac"
      >
        <label htmlFor="search-field" className="sr-only">
          {t('fieldLabel')}
        </label>
        <Search className="text-mu pointer-events-none absolute start-4 size-5" aria-hidden />
        <input
          id="search-field"
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={input}
          maxLength={MAX_QUERY_CHARS}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('placeholder')}
          dir="auto"
          className="placeholder:text-mu h-full min-w-0 flex-1 bg-transparent ps-12 pe-12 text-[17px] outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {input && (
          <button
            type="button"
            aria-label={t('clear')}
            title={t('clear')}
            onClick={() => {
              setInput('');
              inputRef.current?.focus();
            }}
            className="text-mu hover:text-foreground focus-visible:ring-ring/50 absolute end-1 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </form>

      <ScopeChips scope={scope} onScope={onScope} />

      <div role="status" aria-live="polite" className="text-mu -my-1 flex min-h-5 items-center gap-2 text-[13px]">
        {searching && status && <Loader className="size-4 motion-safe:animate-spin" aria-hidden />}
        {status}
      </div>

      <Body index={index} results={results} query={query} searchable={searchable} personId={ready && scope.kind === 'person' ? scope.id : null} loadMore={loadMore} retry={retry} />
    </Shell>
  );
}

function Body({
  index,
  results,
  query,
  searchable,
  personId,
  loadMore,
  retry,
}: {
  index: ReturnType<typeof useSearchIndex>;
  results: ReturnType<typeof useSearch>['state'];
  query: string;
  searchable: boolean;
  personId: string | null;
  loadMore: () => void;
  retry: () => void;
}) {
  const t = useTranslations('search');
  const { state } = index;
  if (state.status === 'building') return <SearchIndexProgress reason={state.reason} done={state.done} total={state.total} onCancel={index.cancel} />;
  if (state.status === 'cancelled') {
    return (
      <SectionCard className="leading-relaxed">
        <p className="font-medium">{t('cancelledTitle')}</p>
        <p className="text-t2">{t('cancelledBody')}</p>
        <div>
          <PillButton variant="outlined" onClick={index.start}>
            {t('resume')}
          </PillButton>
        </div>
      </SectionCard>
    );
  }
  if (state.status === 'unavailable' || (state.status === 'ready' && results.status === 'unavailable')) {
    return (
      <SectionCard className="gap-2 leading-relaxed">
        <p className="font-medium">{t('unavailableTitle')}</p>
        <p className="text-t2">{t('unavailableBody')}</p>
      </SectionCard>
    );
  }
  if (state.status === 'error') return <ErrorNote onRetry={index.start}>{t('loadFailed')}</ErrorNote>;
  if (state.status === 'checking') return null;

  if (!query) return <p className="text-mu leading-relaxed">{t('hint')}</p>;
  if (!searchable) return <p className="text-mu leading-relaxed">{t('tooShort')}</p>;
  if (results.status === 'error') return <ErrorNote onRetry={retry}>{t('loadFailed')}</ErrorNote>;
  if (results.status !== 'ready') return null;

  if (results.items.length === 0 && !results.refreshing) {
    return (
      <SectionCard className="gap-2 leading-relaxed break-words">
        <p dir="auto">{t('noResults', { query })}</p>
        <p className="text-t2">{t('noResultsHint')}</p>
      </SectionCard>
    );
  }
  return (
    <div className="flex flex-col gap-4" aria-busy={results.refreshing}>
      <ul aria-label={t('resultsLabel')} className={`flex flex-col gap-2.5 ${results.refreshing ? 'opacity-60' : ''}`}>
        {results.items.map((item) => (
          <SearchResultItem key={`${item.conversationId}:${item.id}`} item={item} personId={personId} />
        ))}
      </ul>
      <ShowMore
        shown={results.items.length}
        total={results.hasMore ? results.items.length + 1 : results.items.length}
        loading={results.loadingMore}
        failed={results.moreFailed}
        onMore={loadMore}
        labels={{ shown: '', moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
      />
    </div>
  );
}
