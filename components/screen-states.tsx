'use client';

import type { ReactNode } from 'react';
import { Loader } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { Link } from '@/i18n/navigation';

/** A quiet "loading" line (polite status) with a spinner that stops under reduced motion. */
export function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-mu flex min-h-11 items-center gap-2 py-4">
      <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
      {children}
    </p>
  );
}

/** A calm empty state: a flat card with plain words. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <SectionCard>
      <p className="text-t2 leading-relaxed break-words">{children}</p>
    </SectionCard>
  );
}

/** A failed read: says what happened and offers "Try again". Always an alert. */
export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  const tl = useTranslations('library');
  return (
    <SectionCard role="alert">
      <p className="text-foreground leading-relaxed break-words">{children}</p>
      <div>
        <PillButton variant="outlined" onClick={onRetry}>
          {tl('retry')}
        </PillButton>
      </div>
    </SectionCard>
  );
}

/** A person (or link) that does not exist: the way back is to People. */
export function PersonNotFound() {
  const tp = useTranslations('person');
  return (
    <SectionCard>
      <h1 className="font-display text-headline text-balance">{tp('notFoundTitle')}</h1>
      <p className="text-t2 leading-relaxed">{tp('notFoundBody')}</p>
      <div>
        <PillButton asChild variant="outlined">
          <Link href="/people">{tp('back')}</Link>
        </PillButton>
      </div>
    </SectionCard>
  );
}
