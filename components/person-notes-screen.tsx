'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LibraryNotice } from '@/components/library-notice';
import { PersonNoteItem } from '@/components/person-note-item';
import { usePeopleBack, usePersonBack } from '@/components/person-back';
import { EmptyNote, ErrorNote, LoadingNote, PersonNotFound } from '@/components/screen-states';
import { ShowMore } from '@/components/show-more';
import { Shell } from '@/components/screen-shell';
import { useLibrary } from '@/hooks/use-library';
import { usePersonDetails } from '@/hooks/use-person-details';
import { noteItemKey, usePersonNotes } from '@/hooks/use-person-notes';
import type { Note, NoteItem } from '@/lib/domain/library';

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
  const tn = useTranslations('notes');
  const id = useSearchParams().get('id');
  const details = usePersonDetails(id);
  const { state: notes, loadMore, retry, changed } = usePersonNotes(id);
  const [notice, setNotice] = useState('');

  const onChanged = (item: NoteItem, note: Note | null) => {
    changed(item, note);
    setNotice(note ? tn('saved') : tn('deleted'));
  };

  const peopleBack = usePeopleBack();
  const person = details.status === 'ready' ? details.details.person : undefined;
  const personBack = usePersonBack(person ?? { id: id ?? '', displayName: '' });

  if (details.status === 'not-found' || notes.status === 'not-found') {
    return (
      <Shell back={peopleBack}>
        <PersonNotFound />
      </Shell>
    );
  }
  if (details.status === 'error' || notes.status === 'error') {
    return (
      <Shell back={person ? personBack : peopleBack}>
        <ErrorNote onRetry={details.status === 'error' ? onRetry : retry}>{t('loadFailed')}</ErrorNote>
      </Shell>
    );
  }
  if (!person || notes.status === 'loading') {
    return (
      <Shell>
        <LoadingNote>{t('loading')}</LoadingNote>
      </Shell>
    );
  }

  const { items, total, loadingMore, moreFailed } = notes;
  return (
    <Shell back={personBack}>
      <header className="flex items-end justify-between gap-3 px-1">
        <h1 className="font-display text-display">{t('title')}</h1>
        <p className="text-mu pb-1.5 text-end text-sm break-words">{t('count', { count: total, name: person.displayName })}</p>
      </header>
      <p role="status" className="text-mu min-h-5 text-sm break-words">
        {notice}
      </p>

      {total === 0 ? (
        <EmptyNote>
          {t('empty', { name: person.displayName })} {t('emptyHint')}
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2.5">
            {items.map((item) => (
              <PersonNoteItem key={noteItemKey(item)} item={item} personId={person.id} onChanged={onChanged} />
            ))}
          </ul>
          <ShowMore
            shown={items.length}
            total={total}
            loading={loadingMore}
            failed={moreFailed}
            onMore={loadMore}
            labels={{ shown: t('shown', { shown: items.length, total }), moreFailed: t('moreFailed'), showMore: t('showMore'), loadingMore: t('loadingMore') }}
          />
        </div>
      )}
    </Shell>
  );
}
