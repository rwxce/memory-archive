import { entryBaseName, isAppleDouble } from './chat';

/**
 * Canonicalize a media filename for tolerant matching (D-M2 / MEDIA-01):
 * lower-case, drop a trailing parenthesized duplicate marker (`(1)`), and
 * collapse runs of whitespace / `-` / `_` to nothing. Digits are preserved so
 * real date-stamped names stay distinct.
 *
 *   normalizeMediaName('Photo (1).JPG') === normalizeMediaName('photo.jpg')
 *   normalizeMediaName('IMG 20190424 WA0003.jpg') === normalizeMediaName('IMG-20190424-WA0003.jpg')
 */
export function normalizeMediaName(s: string): string {
  return s.toLowerCase().replace(/\(\d+\)/g, '').replace(/[\s_-]+/g, '');
}

/**
 * A file name that is safe to write as a single path segment: no separators,
 * no `.`/`..`, no NUL. ZIP entry names are untrusted.
 */
export function isSafeFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

export interface MediaMatch<T> {
  /** The reference as written in `_chat.txt`. */
  ref: string;
  /** The archive entry it resolved to. */
  entry: T;
  /** Safe base file name to store it under. */
  fileName: string;
}

export interface MediaMatchResult<T> {
  matches: MediaMatch<T>[];
  /** Distinct refs with no matching entry. */
  unresolved: string[];
}

/**
 * Match media references from `_chat.txt` against archive entries by
 * normalized base name. The transcript itself, AppleDouble companions and
 * entries with unsafe names are never matched.
 */
export function matchMediaEntries<T extends { name: string }>(
  entries: T[],
  refs: string[],
): MediaMatchResult<T> {
  const refsNormalized = new Map<string, string>(); // normalized -> original ref
  for (const r of refs) {
    const n = normalizeMediaName(r);
    if (n) refsNormalized.set(n, r);
  }
  const index = new Map<string, T>(); // normalized base -> entry
  for (const e of entries) {
    const base = entryBaseName(e.name);
    if (isAppleDouble(e.name) || base.endsWith('_chat.txt') || !isSafeFileName(base)) continue;
    index.set(normalizeMediaName(base), e);
  }
  const matches: MediaMatch<T>[] = [];
  const unresolved: string[] = [];
  for (const [norm, ref] of refsNormalized) {
    const entry = index.get(norm);
    if (entry) matches.push({ ref, entry, fileName: entryBaseName(entry.name) });
    else unresolved.push(ref);
  }
  return { matches, unresolved };
}
