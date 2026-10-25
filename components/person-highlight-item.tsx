'use client';

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { Link } from '@/i18n/navigation';
import type { HighlightItem } from '@/lib/domain/highlights';
import { formatDay } from './format';

const linkClass = 'text-ac-tx focus-visible:ring-ring/50 -ms-2 flex min-h-11 w-fit items-center rounded-full px-2 text-sm font-semibold underline underline-offset-4 outline-none focus-visible:ring-[3px]';

/**
 * Asks before a highlight is deleted, in a native modal `<dialog>` (focus is trapped and returned to
 * the button that opened it, Escape cancels). Only mounted while asking, so a long list carries one.
 */
function DeleteDialog({ title, onCancel, onConfirm }: { title: string; onCancel: () => void; onConfirm: () => Promise<boolean> }) {
  const t = useTranslations('personHighlights');
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<'asking' | 'deleting' | 'failed'>('asking');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const run = async () => {
    setPhase('deleting');
    if (!(await onConfirm())) setPhase('failed');
  };
  const deleting = phase === 'deleting';

  return (
    <dialog
      ref={dialog}
      aria-labelledby="highlight-delete-title"
      aria-describedby="highlight-delete-body"
      onCancel={(event) => {
        event.preventDefault();
        if (!deleting) onCancel();
      }}
      className="bg-bg text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl p-6 shadow-soft backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id="highlight-delete-title" className="font-display text-headline">
          {t('deleteTitle')}
        </h2>
        <div id="highlight-delete-body" className="flex flex-col gap-2 text-sm">
          <p dir="auto" className="font-medium break-words">
            {title}
          </p>
          <p>{t('deleteBody')}</p>
        </div>
        <p role={phase === 'failed' ? 'alert' : 'status'} className="text-destructive min-h-5 text-sm">
          {phase === 'failed' ? t('deleteFailed') : deleting ? <span className="text-muted-foreground">{t('deleting')}</span> : null}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <PillButton variant="outlined" onClick={onCancel} disabled={deleting} autoFocus>
            {t('cancel')}
          </PillButton>
          <PillButton variant="danger" onClick={run} disabled={deleting}>
            {t('deleteConfirm')}
          </PillButton>
        </div>
      </div>
    </dialog>
  );
}

/**
 * One highlight as a card: its title and summary, which conversation, how many messages and the day
 * of the first one, the way to that day in the conversation and a delete button that asks first.
 * Title, summary and conversation title come from a file and are only ever rendered as text.
 */
export function PersonHighlightItem({
  item,
  personId,
  onDelete,
}: {
  item: HighlightItem;
  personId: string;
  onDelete: (item: HighlightItem) => Promise<boolean>;
}) {
  const t = useTranslations('personHighlights');
  const locale = useLocale();
  const [asking, setAsking] = useState(false);
  const day = formatDay(item.firstSentAt, locale);
  const href = `/conversation?id=${encodeURIComponent(item.conversationId)}&from=${encodeURIComponent(personId)}&date=${item.firstSentAt.slice(0, 10)}`;

  return (
    <li className="bg-sf flex flex-col gap-2 rounded-[20px] px-4 py-3.5 lg:in-data-panel:bg-bg">
      <div className="flex items-start gap-2">
        <h3 dir="auto" className="min-w-0 flex-1 pt-1 text-base leading-snug font-semibold break-words">
          {item.title}
        </h3>
        <button
          type="button"
          aria-label={t('deleteLabel', { title: item.title })}
          title={t('delete')}
          onClick={() => setAsking(true)}
          className="text-mu hover:bg-sf2 focus-visible:ring-ring/50 -me-2 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] [&_svg]:size-4"
        >
          <Trash2 aria-hidden />
        </button>
      </div>
      {item.summary && (
        <p dir="auto" className="text-t2 text-[15px] leading-relaxed break-words whitespace-pre-line">
          {item.summary}
        </p>
      )}
      <p className="text-mu text-sm break-words">
        <span dir="auto">{item.conversationTitle}</span>
        {' · '}
        {t('messages', { count: item.messageCount })}
        {' · '}
        <time dateTime={item.firstSentAt.slice(0, 10)}>{day}</time>
      </p>
      <Link href={href} aria-label={t('openLabel', { title: item.title, when: day })} className={linkClass}>
        {t('open')}
      </Link>
      {asking && (
        <DeleteDialog
          title={item.title}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            const done = await onDelete(item);
            if (done) setAsking(false);
            return done;
          }}
        />
      )}
    </li>
  );
}
