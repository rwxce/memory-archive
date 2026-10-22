/**
 * Turns what a person typed into an FTS5 MATCH expression. The text is NEVER passed to FTS5
 * as typed: operators, column filters (`text:`), `NEAR(`, `AND`/`OR`/`NOT`, `*`, `^`, `-` and
 * quotes would change the meaning or fail to parse. Only letters, digits and combining marks
 * survive, split the way the index tokenizer (`unicode61`) splits; each token becomes a quoted
 * string, so a word such as `OR` or `NEAR` is just a word. The last word also matches as a
 * prefix when it has at least `MIN_PREFIX_CHARS` letters (so results appear while typing; the
 * index has prefix tables for 2 and 3 letters, a 1-letter prefix would walk every word). All
 * words must match (implicit AND).
 *
 * Case and accents are folded by the index tokenizer (`remove_diacritics 2`), not here.
 */

/** Longest query looked at, in characters; the rest is ignored. */
export const MAX_QUERY_CHARS = 200;
/** Most words looked at. */
export const MAX_QUERY_TOKENS = 8;
/** Shortest last word that matches as a prefix; the index is built with `prefix = '2 3'`. */
export const MIN_PREFIX_CHARS = 2;

const isPrefix = (token: string) => [...token].length >= MIN_PREFIX_CHARS;

/** The words of a query, bounded. Empty when there is nothing to search for. */
export function queryTokens(query: string): string[] {
  if (typeof query !== 'string') return [];
  const words = [...query.slice(0, MAX_QUERY_CHARS * 2)].slice(0, MAX_QUERY_CHARS).join('').match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  return words.slice(0, MAX_QUERY_TOKENS);
}

/** The MATCH expression for `query`, or `null` when there is nothing to search for. */
export function toMatchExpression(query: string): string | null {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 && isPrefix(t) ? `"${t}"*` : `"${t}"`)).join(' ');
}

// ---------------------------------------------------------------- snippets

/** Longest snippet text, in characters (an ellipsis may be added at either end). */
export const SNIPPET_CHARS = 140;
/** How much of the text before the first match is kept. */
const SNIPPET_LEAD = 40;

const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The part of `text` around the first word that `query` matches, and the matching words as
 * ranges into that part (UTF-16 offsets). Mirrors the index: words are runs of letters, digits
 * and marks, compared without case and accents; every word of the query matches whole except
 * the last, which matches as a prefix. Plain text in, plain text out: never HTML. A text with no
 * match (the index and this function disagree on an exotic letter) gets its start and no ranges.
 */
export function snippetOf(text: string, query: string): { text: string; ranges: { start: number; end: number }[] } {
  const tokens = queryTokens(query).map(fold);
  const last = tokens.length - 1;
  const matches: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = fold(m[0]);
    if (tokens.some((t, i) => (i === last && isPrefix(t) ? word.startsWith(t) : word === t))) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  const anchor = matches[0]?.start ?? 0;
  let from = Math.max(0, anchor - SNIPPET_LEAD);
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < anchor) from = space + 1;
  }
  // Never cut a surrogate pair (an emoji, a rare letter) in two.
  const isLow = (i: number) => (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  const isHigh = (i: number) => (text.charCodeAt(i) & 0xfc00) === 0xd800;
  if (from > 0 && isLow(from)) from--;
  let to = Math.min(text.length, from + SNIPPET_CHARS);
  if (to < text.length && to > 0 && isHigh(to - 1)) to++;
  const head = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  const ranges = matches.filter((r) => r.start >= from && r.end <= to).map((r) => ({ start: r.start - from + head.length, end: r.end - from + head.length }));
  return { text: head + text.slice(from, to) + tail, ranges };
}
