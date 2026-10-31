'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { useReminders } from '@/hooks/use-reminders';
import { Link } from '@/i18n/navigation';
import { getReminderSettings, type ReminderKind } from '@/lib/usecases/reminders';

const HREF = { backup: '/backup', sync: '/sync' } as const;

/**
 * A small, calm card: a reminder that a backup is due, or that changes have not been shared with
 * another device. Not a dialog: it sits in the page, never blocks, makes no sound and is not
 * announced. "Remind me later" quiets it for a week; "Don't remind me" until reminders are
 * turned off and on again in Settings. `kinds` says which reminders fit the screen; `link` adds
 * the button that goes to the screen where the work is done (leave it off on that screen itself);
 * change `refreshKey` after something that may have cleared it.
 */
export function ReminderCard({ kinds, link = false, refreshKey }: { kinds: readonly ReminderKind[]; link?: boolean; refreshKey?: unknown }) {
  const t = useTranslations('reminders');
  const id = useId();
  const reminders = useReminders(kinds, refreshKey);
  const kind = reminders.due;
  if (!kind) return null;

  // The card is leaving: keep the keyboard on the page instead of on the body.
  const done = (action: (k: ReminderKind) => void) => () => {
    action(kind);
    document.querySelector<HTMLElement>('main h1')?.focus();
  };

  return (
    <SectionCard tone="soft" className="gap-3 p-[18px]" aria-labelledby={`${id}-title`} data-testid="reminder-card" data-kind={kind}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-[15px] font-semibold">
          {t(`${kind}.title`)}
        </h2>
        <p className="text-t2 text-sm leading-relaxed">{t(`${kind}.body`, { days: getReminderSettings(window.localStorage).intervalDays })}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {link && (
          <PillButton asChild>
            <Link href={HREF[kind]}>{t(`${kind}.action`)}</Link>
          </PillButton>
        )}
        <PillButton variant="outlined" onClick={done(reminders.snooze)}>
          {t('later')}
        </PillButton>
        <PillButton variant="ghost-link" onClick={done(reminders.turnOff)}>
          {t('never')}
        </PillButton>
      </div>
    </SectionCard>
  );
}
