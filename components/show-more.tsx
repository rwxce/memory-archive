'use client';

import { Loader } from 'lucide-react';
import { PillButton } from '@/components/pill-button';

/** The paging footer of a grid or list: "Showing x of y", a failure note and the "Show more" pill. */
export function ShowMore({
  shown,
  total,
  loading,
  failed,
  onMore,
  labels,
}: {
  shown: number;
  total: number;
  loading: boolean;
  failed: boolean;
  onMore: () => void;
  labels: { shown: string; moreFailed: string; showMore: string; loadingMore: string };
}) {
  const more = shown < total;
  return (
    <div className="flex flex-col items-stretch gap-2">
      {more && labels.shown && (
        <p role="status" className="text-mu text-center text-sm">
          {labels.shown}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-center text-sm">
          {labels.moreFailed}
        </p>
      )}
      {more && (
        <PillButton variant="outlined" onClick={onMore} aria-disabled={loading || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50">
          {loading && <Loader className="motion-safe:animate-spin" aria-hidden />}
          {loading ? labels.loadingMore : labels.showMore}
        </PillButton>
      )}
    </div>
  );
}
