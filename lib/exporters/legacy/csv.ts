import type { Message } from '../../importers/whatsapp/types';

/**
 * `messages.csv` — the legacy (wa-backup) source of truth. Pure string in /
 * string out; reading and writing files belongs to the caller.
 */

// A cell starting with one of these is a formula to Excel/Sheets/LibreOffice.
const FORMULA_TRIGGER = /^'*[=+\-@\t\r]/;
const FORMULA_PREFIXED = /^'+[=+\-@\t\r]/;

/**
 * Escape a field so EVERY row occupies exactly ONE physical line (G-01-4):
 * backslash -> `\\` first, then CR/LF -> literal `\n` / `\r`. RFC-4180 quoting
 * then only needs to handle quotes and commas.
 *
 * Spreadsheet formula injection: a value starting with `= + - @ TAB CR` (after
 * any run of `'`) gets one leading `'`. `unescapeField` strips exactly one, so
 * the mapping is a bijection and every value round-trips unchanged.
 */
export function csvField(s: string): string {
  const escaped = (FORMULA_TRIGGER.test(s) ? "'" + s : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  if (/[",]/.test(escaped)) return '"' + escaped.replace(/"/g, '""') + '"';
  return escaped;
}

/** Exact inverse of `csvField`'s escaping (single left-to-right pass so
 * `\\n` never double-unescapes) plus the formula-guard `'`. Applied after
 * RFC-4180 field parsing. */
export function unescapeField(s: string): string {
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
  return FORMULA_PREFIXED.test(out) ? out.slice(1) : out;
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

/** Minimal RFC-4180 reader: returns records of raw (still escaped) fields. */
export function parseCsvRecords(text: string): string[][] {
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
 * Parse messages.csv text back into `Message[]` (reverse `csvField` quoting,
 * header skipped). Rows with fewer than 5 fields are skipped; legacy 5-column
 * rows get an empty `urlTitles` map.
 */
export function parseCsv(text: string): Message[] {
  const records = parseCsvRecords(text);
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

/** Header + rows (UTF-8 text, no BOM, D-19). */
export function serializeCsv(messages: Message[]): string {
  let out = csvHeader();
  for (const m of messages) out += csvRow(m);
  return out;
}

/**
 * Incremental merge (D-13/D-16/D-17):
 * 1. count existing rows per `dedupeKey`
 * 2. append an incoming message only when its key has been seen more times in
 *    `incoming` than in `existing` — identical messages sent within the same
 *    minute ("ok", "ok") are distinct rows, and a newer export that adds one
 *    more of them adds exactly one row
 * 3. STABLE sort everything by `timestamp_iso` ascending — equal timestamps
 *    keep insertion order (explicit index tiebreaker)
 * Returns the merged list and the number of NEW rows.
 */
export function mergeMessages(
  existing: Message[],
  incoming: Message[],
): { messages: Message[]; added: number } {
  const remaining = new Map<string, number>();
  for (const m of existing) {
    const k = dedupeKey(m);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const fresh = incoming.filter((m) => {
    const k = dedupeKey(m);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      return false;
    }
    return true;
  });
  const indexed = existing.concat(fresh).map((m, i) => ({ m, i }));
  indexed.sort((a, b) =>
    a.m.timestamp_iso < b.m.timestamp_iso
      ? -1
      : a.m.timestamp_iso > b.m.timestamp_iso
        ? 1
        : a.i - b.i,
  );
  return { messages: indexed.map((e) => e.m), added: fresh.length };
}
