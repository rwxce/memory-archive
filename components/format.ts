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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When something happened, for people: "3 days ago" and the exact local date and time
 * ("12 Mar 2026, 14:05"), both in the UI language. A moment in the future (a clock that moved)
 * reads as "now".
 */
export function formatWhen(iso: string, locale: string, now: number = Date.now()): { relative: string; absolute: string } {
  const at = new Date(iso);
  const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ago = Math.max(0, now - at.getTime());
  let relative: string;
  if (ago < MINUTE) relative = rtf.format(0, 'second');
  else if (ago < HOUR) relative = rtf.format(-Math.floor(ago / MINUTE), 'minute');
  else if (ago < DAY) relative = rtf.format(-Math.floor(ago / HOUR), 'hour');
  else if (ago < 30 * DAY) relative = rtf.format(-Math.floor(ago / DAY), 'day');
  else if (ago < 365 * DAY) relative = rtf.format(-Math.floor(ago / (30 * DAY)), 'month');
  else relative = rtf.format(-Math.floor(ago / (365 * DAY)), 'year');
  return { relative, absolute };
}

/** A day written out in the UI language ("Tuesday, 17 March 2026"), from a wall-clock stamp, never shifted. */
export function formatFullDay(stamp: string, locale: string): string {
  const [year, month, day] = stamp.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

const wallClock = (stamp: string) => {
  const [year, month, day] = stamp.slice(0, 10).split('-').map(Number);
  const [hour = 0, minute = 0] = stamp.slice(11, 16).split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
};

/** A moment ("12 Mar 2024, 09:47") in the UI language, from a wall-clock stamp, shown as written, never shifted. */
export function formatDayTime(stamp: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(wallClock(stamp));
}

/** "March 2024" in the UI language, from a wall-clock stamp, never shifted. */
export function formatMonth(stamp: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(wallClock(stamp));
}
