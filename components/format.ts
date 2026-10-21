/** Human file size in the UI language: "1.2 GB", "340 kB" (decimal units, like phones show). */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 && i > 0 ? 1 : 0,
  }).format(value);
}

/**
 * Up to two letters for an avatar: the first letter of the first and last word
 * of a name ("Ana Maria Puig" → "AP"). Works on whole characters, so emoji and
 * accented letters are never cut in half. Never empty ("?" for a blank name).
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (word: string | undefined) => (word ? (Array.from(word)[0] ?? '') : '');
  const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return letters ? letters.toLocaleUpperCase() : '?';
}

/**
 * A day, in the UI language ("12 Mar 2024"), from a WhatsApp wall-clock stamp
 * (`2024-03-12T09:47:18`, no timezone: shown as written, never shifted).
 */
export function formatDay(stamp: string, locale: string): string {
  const [year, month, day] = stamp.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** "12 Mar 2024" for one day, "12 Mar 2024 – 3 Jul 2025" for a span; '' when there are no dates. */
export function formatDateRange(first: string | null, last: string | null, locale: string): string {
  if (!first || !last) return '';
  const a = formatDay(first, locale);
  const b = formatDay(last, locale);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * Names as a list in the UI language: "Ana, Bo, and Cy", or, when more follow
 * ("... and 2 others"), "Ana, Bo, Cy" so the sentence does not say "and" twice.
 */
export function formatNames(names: string[], locale: string, more = false): string {
  return new Intl.ListFormat(locale, { style: 'long', type: more ? 'unit' : 'conjunction' }).format(names);
}
