import { useLocale } from 'next-intl';

/** "September <i>2019</i>": a serif heading with the year in italic accent. `month` is `YYYY-MM`. */
export function MonthHeading({ month, id }: { month: string; id?: string }) {
  const locale = useLocale();
  const [year, m] = month.split('-').map(Number);
  const parts = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(year, m - 1, 1)));
  return (
    <h2 id={id} className="font-display text-name px-1 sm:text-3xl">
      {parts.map((part, i) =>
        part.type === 'year' ? (
          <span key={i} className="text-ac-tx italic">
            {part.value}
          </span>
        ) : (
          part.value
        ),
      )}
    </h2>
  );
}
