'use client';

import { useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { LibraryNotice } from '@/components/library-notice';
import { PageTitle } from '@/components/page-title';
import { PhotosAddCards } from '@/components/photos-add-cards';
import { PhotosBatchesCard } from '@/components/photos-batches-card';
import { PhotosNotes } from '@/components/photos-notes';
import { PhotosRunStatus } from '@/components/photos-run-status';
import { PhotosSelectLink } from '@/components/photos-select-link';
import { Shell } from '@/components/screen-shell';
import { usePhotoBatches } from '@/hooks/use-photo-batches';
import { usePhotoImport } from '@/hooks/use-photo-import';
import { useLibrary } from '@/hooks/use-library';

/**
 * Photos: bring pictures and videos into the collection, from a Google Photos download or Takeout ZIP (told apart by
 * its content, not its name) or from the device's gallery, and take an earlier import back. Choosing pictures for people is
 * the next screen (`/photos/select`); nothing here assigns one. One import runs at a time. The library opens here because all of it needs it.
 */
export function PhotosScreen() {
  const { state, retry } = useLibrary();
  if (state.status !== 'ready') {
    return (
      <Shell back={{ href: '/settings' }}>
        <LibraryNotice state={state} onRetry={retry} />
      </Shell>
    );
  }
  return <PhotosContent />;
}

function PhotosContent() {
  const t = useTranslations('photos');
  const tn = useTranslations('settings');
  const batches = usePhotoBatches();
  const { reload, clearOutcome } = batches;
  const onSettled = useCallback(() => void reload(), [reload]);
  const run = usePhotoImport(onSettled);
  const working = run.state.status === 'working' || run.state.status === 'checking';

  // A new import has begun: the last undo's result is old news.
  useEffect(() => {
    if (working) clearOutcome();
  }, [working, clearOutcome]);

  return (
    <Shell back={{ href: '/settings', label: tn('title') }}>
      <div className="flex flex-col gap-1.5">
        <PageTitle tabIndex={-1}>{t('title')}</PageTitle>
        <p className="text-t2 leading-relaxed">{t('intro')}</p>
      </div>
      <PhotosNotes />
      <PhotosAddCards run={run} disabled={working || batches.undo.status === 'working'} />
      <PhotosRunStatus run={run} />
      <PhotosSelectLink version={batches.state} />
      <PhotosBatchesCard batches={batches} disabled={working} />
    </Shell>
  );
}
