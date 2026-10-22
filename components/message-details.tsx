'use client';

import { Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { MessageSource } from '@/lib/domain/library';
import type { MessageSourceState } from '@/hooks/use-message-source';
import { formatWhen } from './format';

/** The small button beside a bubble that opens its details. Quiet until hovered or focused; always there on touch. */
export function DetailsButton({ open, panelId, onToggle }: { open: boolean; panelId: string; onToggle: () => void }) {
  const t = useTranslations('conversation.details');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t('toggle')}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={onToggle}
      // The 44 px target sits beside the bubble and does not add to the row's height.
      className={cn(
        'text-muted-foreground -my-2 rounded-full',
        '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 focus-visible:opacity-100',
        open && 'opacity-100!',
      )}
    >
      <Info aria-hidden />
    </Button>
  );
}

const known: Record<string, 'whatsapp'> = { whatsapp: 'whatsapp' };

function Ready({ source }: { source: MessageSource }) {
  const t = useTranslations('conversation.details');
  const locale = useLocale();
  const kind = known[source.source];
  const name = kind ? t(`sources.${kind}`) : source.source;
  const when = Number.isNaN(new Date(source.importedAt).getTime()) ? '' : formatWhen(source.importedAt, locale).absolute;
  return (
    <>
      <p>{source.sourceLabel ? t('sourceFile', { name, file: source.sourceLabel }) : t('source', { name })}</p>
      {when && <p>{t('imported', { date: when })}</p>}
    </>
  );
}

/** What the details say: loading, the source and import date, or a calm note. Everything is text. */
export function MessageDetails({ id, align, state, onRetry }: { id: string; align: 'start' | 'end'; state: MessageSourceState; onRetry: () => void }) {
  const t = useTranslations('conversation.details');
  const retry = useTranslations('conversation')('retry');
  return (
    <div className={cn('flex', align === 'end' ? 'justify-end' : 'justify-start')}>
      <div
        id={id}
        dir="auto"
        aria-busy={state.status === 'loading'}
        className="bg-muted/60 text-muted-foreground mt-1 flex max-w-[85%] min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-xs leading-snug [overflow-wrap:anywhere] sm:max-w-[75%]"
      >
        {state.status === 'loading' && <p role="status">{t('loading')}</p>}
        {state.status === 'ready' && <Ready source={state.source} />}
        {state.status === 'not-found' && <p>{t('notFound')}</p>}
        {state.status === 'error' && (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">{t('failed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {retry}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
