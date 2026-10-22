'use client';

import { useEffect, useRef } from 'react';
import { ArrowLeft, Loader, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { Shell } from '@/components/screen-shell';
import { SearchIndexProgress } from '@/components/search-index-progress';
import { SearchResultItem } from '@/components/search-result-item';
import { Button } from '@/components/ui/button';
import { useLibrary } from '@/hooks/use-library';
import { isSearchable, useSearch, useSearchInput } from '@/hooks/use-search';
import { useSearchIndex } from '@/hooks/use-search-index';
import { useSearchScope, type SearchScopeState } from '@/hooks/use-search-scope';
import { Link } from '@/i18n/navigation';
import { MAX_QUERY_CHARS } from '@/lib/domain/search-query';

const linkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

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
  const tp = useTranslations('person');
  const params = useSearchParams();
  const { state: scope, retry: retryScope } = useSearchScope(params.get('person'), params.get('conversation'));

  if (scope.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{t('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{t('notFoundBody')}</p>
          <Link href="/people" className={linkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {tp('back')}
          </Link>
        </section>
      </Shell>
    );
  }
  if (scope.status === 'error') {
    return (
      <Shell>
        <RetryCard text={t('loadFailed')} onRetry={retryScope} />
      </Shell>
    );
  }
  return <SearchPanel scope={scope} initialQuery={params.get('q') ?? ''} />;
}

function RetryCard({ text, onRetry }: { text: string; onRetry: () => void }) {
  const tl = useTranslations('library');
  return (
    <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
      <p>{text}</p>
      <div>
        <Button variant="outline" onClick={onRetry} className="min-h-11">
          {tl('retry')}
        </Button>
      </div>
    </section>
  );
}

function SearchPanel({ scope, initialQuery }: { scope: Exclude<SearchScopeState, { status: 'not-found' | 'error' }>; initialQuery: string }) {
  const t = useTranslations('search');
  const tp = useTranslations('person');
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

  const kind = ready ? scope.kind : 'all';
  const back =
    kind === 'person' && ready
      ? { href: `/person?id=${encodeURIComponent(scope.id!)}`, text: t('backToPerson', { name: scope.label ?? '' }) }
      : kind === 'conversation' && ready
        ? { href: `/conversation?id=${encodeURIComponent(scope.id!)}`, text: t('backToConversation', { title: scope.label ?? '' }) }
        : { href: '/people', text: tp('back') };
  const widen = `/search${input.trim() ? `?q=${encodeURIComponent(input.trim())}` : ''}`;

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
      <Link href={back.href} className={linkClass}>
        <ArrowLeft className="size-4" aria-hidden />
        {back.text}
      </Link>
      <h1 className="font-serif text-3xl">{t('title')}</h1>

      <div className="flex flex-col gap-1">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
          className="relative"
        >
          <label htmlFor="search-field" className="sr-only">
            {t('fieldLabel')}
          </label>
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden />
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
            className="bg-background focus-visible:ring-ring/50 h-12 w-full rounded-lg border pr-12 pl-10 text-base outline-none focus-visible:ring-[3px] [&::-webkit-search-cancel-button]:hidden"
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
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg outline-none focus-visible:ring-[3px]"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </form>
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 text-sm">
          <p className="text-muted-foreground break-words" dir="auto">
            {!ready ? '' : scope.kind === 'all' ? t('scopeAll') : scope.kind === 'person' ? t('scopePerson', { name: scope.label ?? '' }) : t('scopeConversation', { title: scope.label ?? '' })}
          </p>
          {ready && scope.kind !== 'all' && (
            <Link href={widen} className="text-primary focus-visible:ring-ring/50 flex min-h-11 items-center rounded-md font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]">
              {t('widen')}
            </Link>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite" className="text-muted-foreground -my-3 flex min-h-6 items-center gap-2 text-sm">
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
      <section className="bg-card flex flex-col gap-3 rounded-xl border p-5 leading-relaxed">
        <p className="font-medium">{t('cancelledTitle')}</p>
        <p className="text-muted-foreground">{t('cancelledBody')}</p>
        <div>
          <Button variant="outline" onClick={index.start} className="min-h-11">
            {t('resume')}
          </Button>
        </div>
      </section>
    );
  }
  if (state.status === 'unavailable' || (state.status === 'ready' && results.status === 'unavailable')) {
    return (
      <section className="bg-card flex flex-col gap-2 rounded-xl border p-5 leading-relaxed">
        <p className="font-medium">{t('unavailableTitle')}</p>
        <p className="text-muted-foreground">{t('unavailableBody')}</p>
      </section>
    );
  }
  if (state.status === 'error') return <RetryCard text={t('loadFailed')} onRetry={index.start} />;
  if (state.status === 'checking') return null;

  if (!query) return <p className="text-muted-foreground leading-relaxed">{t('hint')}</p>;
  if (!searchable) return <p className="text-muted-foreground leading-relaxed">{t('tooShort')}</p>;
  if (results.status === 'error') return <RetryCard text={t('loadFailed')} onRetry={retry} />;
  if (results.status !== 'ready') return null;

  if (results.items.length === 0 && !results.refreshing) {
    return (
      <section className="bg-card flex flex-col gap-2 rounded-xl border p-5 leading-relaxed break-words">
        <p dir="auto">{t('noResults', { query })}</p>
        <p className="text-muted-foreground">{t('noResultsHint')}</p>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-4" aria-busy={results.refreshing}>
      <ul aria-label={t('resultsLabel')} className={`flex flex-col gap-3 ${results.refreshing ? 'opacity-60' : ''}`}>
        {results.items.map((item) => (
          <SearchResultItem key={`${item.conversationId}:${item.id}`} item={item} personId={personId} />
        ))}
      </ul>
      <div className="flex flex-col items-start gap-2">
        {results.moreFailed && (
          <p role="alert" className="text-destructive text-sm">
            {t('moreFailed')}
          </p>
        )}
        {results.hasMore && (
          <Button variant="outline" onClick={loadMore} aria-disabled={results.loadingMore || undefined} className="min-h-11 aria-disabled:pointer-events-none aria-disabled:opacity-50">
            {results.loadingMore && <Loader className="motion-safe:animate-spin" aria-hidden />}
            {results.loadingMore ? t('loadingMore') : t('showMore')}
          </Button>
        )}
      </div>
    </div>
  );
}
