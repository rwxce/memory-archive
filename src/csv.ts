import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import type { Message } from './parse/types';

/**
 * Escape a field so EVERY row occupies exactly ONE physical line (G-01-4):
 * backslash -> `\\` first, then CR/LF -> literal `\n` / `\r`. RFC-4180 quoting
 * then only needs to handle quotes and commas.
 */
export function csvField(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  if (/[",]/.test(escaped)) return '"' + escaped.replace(/"/g, '""') + '"';
  return escaped;
}

/** Exact inverse of `csvField`'s escaping (single left-to-right pass so
 * `\\n` never double-unescapes). Applied after RFC-4180 field parsing. */
function unescapeField(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      if (c === 'n') { out += '\n'; i++; continue; }
      if (c === 'r') { out += '\r'; i++; continue; }
      if (c === '\\') { out += '\\'; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

function jsonOrEmpty(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function csvRow(m: Message): string {
  return [m.timestamp_iso, m.type, m.author, m.text, m.media, JSON.stringify(m.urlTitles ?? {})]
    .map(csvField)
    .join(',') + '\n';
}

export function csvHeader(): string {
  return 'timestamp_iso,type,author,text,media,url_titles\n';
}

/**
 * Dedupe identity is the tuple `(timestamp_iso, author, text, media)` joined
 * with the ASCII Unit Separator 0x1F, which cannot appear in chat content —
 * legitimate text can never collide across fields (D-16).
 */
export function dedupeKey(m: Message): string {
  return [m.timestamp_iso, m.author, m.text, m.media].join('\u001f');
}

/** Minimal RFC-4180 reader: returns records of raw field strings. */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n') {
      record.push(field);
      field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  return records;
}

/**
 * Parse a messages.csv back into `Message[]` (reverse `csvField` quoting,
 * header skipped). Rows with the wrong field count are preserved verbatim in
 * `text` to avoid data loss on malformed external edits (T-01-06).
 */
export function readCsv(path: string): Message[] {
  const records = parseCsvRecords(readFileSync(path, 'utf8'));
  const out: Message[] = [];
  for (const rec of records.slice(1)) {
    if (rec.length < 5) continue;
    out.push({
      timestamp_iso: unescapeField(rec[0]),
      type: rec[1] as Message['type'],
      author: unescapeField(rec[2]),
      text: unescapeField(rec[3]),
      media: unescapeField(rec[4]),
      urlTitles: rec.length >= 6 ? jsonOrEmpty(unescapeField(rec[5])) : {},
    });
  }
  return out;
}

/**
 * Write header + rows (first-write / overwrite path; UTF-8 adds NO BOM, D-19).
 */
export function writeCsv(path: string, messages: Message[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(path, { encoding: 'utf8' });
    ws.on('error', reject);
    ws.write(csvHeader());
    for (const m of messages) ws.write(csvRow(m));
    ws.end(() => resolve());
  });
}

/**
 * Incremental merge into an existing CSV source-of-truth (D-13/D-16/D-17):
 * 1. load existing rows (if any), index them by `dedupeKey`
 * 2. append only newMessages whose key is absent
 * 3. STABLE sort everything by `timestamp_iso` ascending — equal timestamps
 *    keep insertion order (`sort` is stable per spec; the tiebreaker index
 *    makes it explicit for engines without stable sort)
 * 4. rewrite header + rows (UTF-8 no BOM)
 * Returns the number of NEW rows added.
 */
export async function mergeCsv(
  path: string,
  newMessages: Message[],
): Promise<number> {
  const existing = existsSync(path) ? readCsv(path) : [];
  const seen = new Set(existing.map(dedupeKey));
  const fresh = newMessages.filter((m) => !seen.has(dedupeKey(m)));

  const combined = existing.concat(fresh);
  // Stable ascending sort by timestamp (D-17). Index tiebreaker preserves the
  // original relative order of equal-timestamp rows (same-second bursts).
  const indexed = combined.map((m, i) => ({ m, i }));
  indexed.sort((a, b) =>
    a.m.timestamp_iso < b.m.timestamp_iso
      ? -1
      : a.m.timestamp_iso > b.m.timestamp_iso
        ? 1
        : a.i - b.i,
  );

  await writeCsv(path, indexed.map((e) => e.m));
  return fresh.length;
}
