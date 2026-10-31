'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { SectionCard } from '@/components/section-card';
import { SegmentedControl } from '@/components/segmented-control';
import { useReminderSettings } from '@/hooks/use-reminders';
import { REMINDER_INTERVALS } from '@/lib/usecases/reminders';

/** Settings: whether the in-app reminders appear at all, and after how many days. They only ever show a card inside the app. */
export function ReminderSettingsCard() {
  const t = useTranslations('settings.reminders');
  const id = useId();
  const [settings, update] = useReminderSettings();

  return (
    <SectionCard className="gap-3 p-[18px]" aria-labelledby={`${id}-title`}>
      <Eyebrow as="h2" id={`${id}-title`} tone="muted" className="tracking-widest">
        {t('title')}
      </Eyebrow>
      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
          className="accent-ac focus-visible:ring-ring/50 size-5 shrink-0 outline-none focus-visible:ring-[3px]"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium">{t('toggle')}</span>
          <span className="text-mu block text-xs leading-snug">{t('hint')}</span>
        </span>
      </label>
      {settings.enabled && (
        <div className="flex flex-col gap-2">
          <span className="text-t2 text-sm" id={`${id}-interval`}>
            {t('interval')}
          </span>
          <SegmentedControl
            label={t('interval')}
            value={String(settings.intervalDays)}
            options={REMINDER_INTERVALS.map((days) => ({ value: String(days), label: t('days', { count: days }) }))}
            onChange={(value) => update({ intervalDays: Number(value) as (typeof REMINDER_INTERVALS)[number] })}
          />
        </div>
      )}
    </SectionCard>
  );
}
