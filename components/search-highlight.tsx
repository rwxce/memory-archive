import type { SearchRange } from '@/lib/domain/library';

/**
 * The pieces of `text` to show: the matching ranges (UTF-16 offsets) marked, the rest plain. Ranges
 * that are out of order, overlap, are empty or run past the text are skipped rather than trusted.
 */
export function splitByRanges(text: string, ranges: SearchRange[]): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > text.length) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

/** A snippet with its matches in `<mark>`. Everything is a React text child: never parsed as HTML. */
export function Highlighted({ text, ranges }: { text: string; ranges: SearchRange[] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-primary/20 text-foreground rounded-sm px-0.5 font-medium">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
