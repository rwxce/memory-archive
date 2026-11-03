import { URL_RE, isHttpUrl, safeLinkUrl, trimTrailingPunct } from '../../lib/exporters/legacy/js/linkify.js';

/**
 * Text helpers of the viewer: accent- and case-insensitive matching with a map back to the
 * original text (for highlighting), and URL detection. Pure: no DOM.
 */

const ASCII = /^[\x00-\x7f]*$/;
const MARKS = /\p{M}/gu;

function foldChar(ch: string): string {
  return ch.normalize('NFD').replace(MARKS, '').toLowerCase();
}

/** Lower-case and strip accents, one code point at a time (so a map back to the text is exact). */
export function fold(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase();
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

/** Search terms: the query folded and split on whitespace. */
export function queryTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

export interface Range {
  start: number;
  end: number;
}

function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    i += ch.length;
  }
  return { folded, starts, ends };
}

/** Where every term occurs in `text` (original offsets), merged and sorted. */
export function findRanges(text: string, terms: readonly string[]): Range[] {
  if (terms.length === 0 || text === '') return [];
  const ascii = ASCII.test(text);
  const mapped = ascii ? null : foldWithMap(text);
  const folded = mapped ? mapped.folded : text.toLowerCase();
  const found: Range[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      const stop = at + term.length;
      found.push(mapped ? { start: mapped.starts[at], end: mapped.ends[stop - 1] } : { start: at, end: stop });
      from = stop;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export interface TextPart {
  start: number;
  end: number;
  /** http(s) target, or null for plain text. */
  href: string | null;
}

/** Splits text into plain parts and http(s) links. The parts cover the whole text. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const url: string = trimTrailingPunct(m[0]);
    const href: string = safeLinkUrl(url);
    if (url === '' || !isHttpUrl(href)) continue;
    if (m.index > last) parts.push({ start: last, end: m.index, href: null });
    parts.push({ start: m.index, end: m.index + url.length, href });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) parts.push({ start: last, end: text.length, href: null });
  return parts;
}

/** A short excerpt around the first range, with the ranges shifted into it. */
export function snippet(text: string, ranges: readonly Range[], before = 40, after = 90): { text: string; ranges: Range[] } {
  const flat = text.replace(/\s+/g, ' ');
  if (flat.length <= before + after) return { text: flat, ranges: findShifted(text, flat, ranges) };
  const first = ranges[0]?.start ?? 0;
  const from = Math.max(0, first - before);
  const to = Math.min(flat.length, from + before + after);
  const cut = flat.slice(from, to);
  const lead = from > 0 ? '…' : '';
  const trail = to < flat.length ? '…' : '';
  const out = lead + cut + trail;
  const shifted = findShifted(text, flat, ranges)
    .map((r) => ({ start: Math.max(r.start, from) - from + lead.length, end: Math.min(r.end, to) - from + lead.length }))
    .filter((r) => r.end > r.start);
  return { text: out, ranges: shifted };
}

/** Ranges are over the original text; whitespace folding below keeps length (each run becomes ONE char). */
function findShifted(original: string, flat: string, ranges: readonly Range[]): Range[] {
  if (original.length === flat.length) return ranges.map((r) => ({ ...r }));
  // Map original offsets to flat offsets (runs of whitespace collapse to one space).
  const map: number[] = new Array(original.length + 1);
  let o = 0;
  let f = 0;
  while (o < original.length) {
    if (/\s/.test(original[o])) {
      let e = o;
      while (e < original.length && /\s/.test(original[e])) e++;
      for (let k = o; k < e; k++) map[k] = f;
      f += 1;
      o = e;
    } else {
      map[o] = f;
      f++;
      o++;
    }
  }
  map[original.length] = f;
  return ranges.map((r) => ({ start: map[r.start], end: Math.max(map[r.start], map[r.end]) })).filter((r) => r.end > r.start);
}
