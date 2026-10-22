'use client';

import { useState } from 'react';
import { ArrowLeft, Loader } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonNoteItem } from '@/components/person-note-item';
import { PersonSections } from '@/components/person-sections';
import { Shell } from '@/components/screen-shell';
import { Button } from '@/components/ui/button';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { noteItemKey, usePersonNotes } from '@/hooks/use-person-notes';
import { Link } from '@/i18n/navigation';
import type { Note, NoteItem } from '@/lib/domain/library';

const linkClass =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-fit items-center gap-2 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]';

/**
 * A person's notes: the one on the person, those on their conversations and those on messages in
 * them, most recently edited first. The person is chosen by `?id=`. Notes come 50 at a time with
 * "Show more"; each can be edited or deleted in place, and the list says what happened in a live
 * region. A note is text typed by the person, shown as text.
 */
export function PersonNotesScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PersonNotesContent onRetry={retry} />;
}

function PersonNotesContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('personNotes');
  const tp = useTranslations('person');
  const tl = useTranslations('library');
  const tn = useTranslations('notes');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: notes, loadMore, retry, changed } = usePersonNotes(id);
  const [notice, setNotice] = useState('');

  const onChanged = (item: NoteItem, note: Note | null) => {
    changed(item, note);
    setNotice(note ? tn('saved') : tn('deleted'));
  };

  if (details.status === 'not-found' || notes.status === 'not-found') {
    return (
      <Shell>
        <section className="bg-card flex flex-col gap-3 rounded-xl border p-6">
          <h1 className="font-serif text-2xl">{tp('notFoundTitle')}</h1>
          <p className="text-muted-foreground leading-relaxed">{tp('notFoundBody')}</p>
          <Link href="/people" className={linkClass}>
            <ArrowLeft className="size-4" aria-hidden />
            {tp('back')}
          </Link>
        </section>
      </Shell>
    );
  }
  if (details.status === 'error' || notes.status === 'error') {
    return (
      <Shell>
        <Link href={id ? `/person?id=${encodeURIComponent(id)}` : '/people'} className={linkClass}>
          <ArrowLeft className="size-4" aria-hidden />
          {id ? tp('backToPerson') : tp('back')}
        </Link>
        <section role="alert" className="bg-card flex flex-col gap-3 rounded-xl border p-5">
          <p>{t('loadFailed')}</p>
          <div>
            <Button variant="outline" onClick={details.status === 'error' ? onRetry : retry}>
              {tl('retry')}
            </Button>
          </div>
        </section>
      </Shell>
    );
  }
  if (details.status === 'loading' || notes.status === 'loading') {
    return (
      <Shell>
        <p role="status" className="text-muted-foreground flex items-center gap-2 py-6">
          <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('loading')}
        </p>
      </Shell>
    );
  }

  const person = details.details.person;
  const { items, total, loadingMore, moreFailed } = notes;
  return (
    <Shell>
      <Link href={`/person?id=${encodeURIComponent(person.id)}`} className={linkClass}>
        <ArrowLeft className="size-4" aria-hidden />
        {t('back', { name: person.displayName })}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl break-words">{t('title')}</h1>
        <p className="text-muted-foreground break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>
      <PersonSections personId={person.id} current="notes" />
      <p role="status" className="text-muted-foreground min-h-5 text-sm break-words">
        {notice}
      </p>

      {total === 0 ? (
        <section className="bg-card flex flex-col gap-2 rounded-xl border p-5 leading-relaxed break-words">
          <p>{t('empty', { name: person.displayName })}</p>
          <p className="text-muted-foreground">{t('emptyHint')}</p>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <PersonNoteItem key={noteItemKey(item)} item={item} personId={person.id} onChanged={onChanged} />
            ))}
          </ul>
          <div className="flex flex-col items-start gap-2">
            {items.length < total && (
              <p role="status" className="text-muted-foreground text-sm">
                {t('shown', { shown: items.length, total })}
              </p>
            )}
            {moreFailed && (
              <p role="alert" className="text-destructive text-sm">
                {t('moreFailed')}
              </p>
            )}
            {items.length < total && (
              <Button variant="outline" onClick={loadMore} aria-disabled={loadingMore || undefined} className="min-h-11 aria-disabled:pointer-events-none aria-disabled:opacity-50">
                {loadingMore && <Loader className="motion-safe:animate-spin" aria-hidden />}
                {loadingMore ? t('loadingMore') : t('showMore')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
