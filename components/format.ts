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
