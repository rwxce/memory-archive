/**
 * Names inside an export ZIP. Titles and profile names are untrusted text: they only ever pass
 * through `slug`, which keeps `[a-z0-9-]`, so a name can never carry a path separator, `..`, a drive
 * letter, control characters or markup. Uniqueness comes from the position, not from the text.
 */

const MAX_SLUG = 40;

export function slug(text: string, fallback: string): string {
  const folded = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  let end = Math.min(folded.length, MAX_SLUG);
  while (start < end && folded[start] === '-') start++;
  while (end > start && folded[end - 1] === '-') end--;
  return folded.slice(start, end) || fallback;
}

/** `001-title`: the 1-based position (padded to at least 3 digits) keeps names unique and ordered. */
export function numberedName(index: number, total: number, title: string, fallback: string): string {
  const width = Math.max(3, String(total).length);
  return `${String(index + 1).padStart(width, '0')}-${slug(title, fallback)}`;
}

/** Folder names for profiles, unique even when two profiles slug to the same text. */
export function folderNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = slug(name, 'profile');
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}
