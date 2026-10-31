'use client';

import { CheckCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { PhotoFilter } from '@/hooks/use-photo-grid';
import { PHOTO_FILTERS } from '@/hooks/use-photo-grid';
import type { PhotoCounts } from '@/lib/domain/photo';
import type { PhotoMonths } from '@/lib/usecases/photo-assign';
import { FilterChip } from './filter-chip';

interface Props {
  filter: PhotoFilter;
  counts: PhotoCounts | undefined;
  months: PhotoMonths | undefined;
  selecting: boolean;
  onFilter(filter: PhotoFilter): void;
  onSelecting(on: boolean): void;
  onJump(target: string): void;
}

/** What to show (Not assigned / Assigned / All), the Select switch, and a jump to a month. */
export function PhotoSelectToolbar({ filter, counts, months, selecting, onFilter, onSelecting, onJump }: Props) {
  const t = useTranslations('photos.select');
  const format = useFormatter();
  const number = (key: PhotoFilter) => (counts ? (key === 'all' ? counts.pictures : key === 'unassigned' ? counts.unassigned : counts.pictures - counts.unassigned) : undefined);
  const monthName = (month: string) => format.dateTime(new Date(`${month}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const hasJump = months && (months.months.length > 0 || months.undated > 0);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t('filter.label')} className="flex flex-wrap gap-2">
        {PHOTO_FILTERS.map((key) => (
          <FilterChip key={key} pressed={filter === key} onPressedChange={() => filter !== key && onFilter(key)}>
            {t(`filter.${key}`)}
            {number(key) !== undefined && <span className="tabular-nums opacity-80">{format.number(number(key)!)}</span>}
          </FilterChip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <FilterChip pressed={selecting} onPressedChange={onSelecting} data-testid="select-toggle">
          <CheckCheck aria-hidden />
          {t('selectMode')}
        </FilterChip>
        {hasJump && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-t2">{t('jump.label')}</span>
            <select
              value=""
              onChange={(event) => event.target.value && onJump(event.target.value)}
              className="border-line bg-sf focus-visible:ring-ring/50 min-h-11 max-w-[60vw] rounded-xl border px-3 outline-none focus-visible:ring-[3px]"
            >
              <option value="">{t('jump.placeholder')}</option>
              {months.months.map(({ month, count }) => (
                <option key={month} value={month}>
                  {t('jump.option', { name: monthName(month), count })}
                </option>
              ))}
              {months.undated > 0 && <option value="undated">{t('jump.undated', { count: months.undated })}</option>}
            </select>
          </label>
        )}
      </div>
      <p className="text-t2 text-sm leading-relaxed">{t('hint')}</p>
    </div>
  );
}
