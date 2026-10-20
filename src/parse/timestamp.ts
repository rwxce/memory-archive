import { format } from 'date-fns';

/**
 * Invisible/zero-width characters that WhatsApp embeds before `[` in real
 * pt-BR exports (U+200E before `[`). Stripping a LEADING run of these before
 * timestamp detection prevents missing messages (D-12). We never strip
 * invisibles *inside* author/text — they carry meaning (bidi phone wrappers).
 */
const INVISIBLE_CHARS =
  '\\uFEFF\\u200E\\u200F\\u200B\\u200C\\u200D\\u2066\\u2067\\u2068\\u2069';

const INVISIBLE_RE = new RegExp(`^[${INVISIBLE_CHARS}]+`, 'u');
const INVISIBLE_TRIM_RE = new RegExp(`^[${INVISIBLE_CHARS}]+|[${INVISIBLE_CHARS}]+$`, 'gu');

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

/** Strip leading AND trailing invisible runs (used on message bodies). */
export function trimInvisible(s: string): string {
  return s.replace(INVISIBLE_TRIM_RE, '');
}

/**
 * Timestamp regex — per-line auto-detection of iOS `[..]` and Android `..`
 * styles, `/ . -` separators, optional seconds, optional brackets, optional
 * AM/PM (D-03). Anchored `^` + fixed alternation => linear time (no ReDoS,
 * T-01-04).
 *
 * Captures: 1=day 2=month 3=year 4=hour 5=min 6=sec? 7=ampm?
 */
export const TS_RE =
  /^\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm|AM|PM)?\]?/;

/** Per-file format decision (PARSE-03): applied to EVERY line of one export. */
export interface Detection {
  /** Ambiguous dates (both parts <= 12) read day-first when true. */
  dayFirst: boolean;
  /** Any AM/PM token in the file => all times are 12h (D-02). */
  is12h: boolean;
  /** Example line that informed the decision (verbose reporting, D-07). */
  example?: string;
  /** True when CLI flags short-circuited the day/month vote (D-07). */
  overridden?: boolean;
}

export interface DetectOptions {
  dayFirst?: boolean;
  monthFirst?: boolean;
}

export interface ParsedTimestamp {
  day: number;
  month: number;
  year: number;
  hour: number;
  min: number;
  sec: number;
  iso: string;
}

export interface TimestampOpts extends DetectOptions {
  is12h?: boolean;
}

const SANITY_MIN_YEAR = 2009;

/** Sliding-window year resolution (D-05): exported for unit testing.
 * `yy <= currentYear-2000+1 ? 2000+yy : 1900+yy`. */
export function resolveYear(yearRaw: number): number {
  if (yearRaw >= 100) return yearRaw;
  const cur = new Date().getFullYear();
  return yearRaw <= cur - 2000 + 1 ? 2000 + yearRaw : 1900 + yearRaw;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
  );
}

/**
 * Decide day/month order + 12h/24h for ONE file (PARSE-03).
 *
 * - `--day-first` / `--month-first` short-circuit the vote (D-01).
 * - Otherwise: majority vote over ambiguous timestamped lines among the first
 *   ~50 samples — whichever ordering yields more VALID calendar dates wins;
 *   tie defaults to DAY-FIRST (pt-BR, assumption A2).
 * - `is12h`: ANY sampled line carries an AM/PM token (D-02).
 */
export function detectFormat(
  lines: string[],
  opts: DetectOptions = {},
): Detection {
  const overridden = Boolean(opts.dayFirst || opts.monthFirst);

  const sampled: RegExpExecArray[] = [];
  let example: string | undefined;
  for (const raw of lines) {
    const s = stripInvisible(raw);
    const m = TS_RE.exec(s);
    if (!m) continue;
    if (sampled.length === 0) example = s.slice(0, m[0].length);
    sampled.push(m);
    if (sampled.length >= 50) break;
  }

  const is12h = sampled.some((m) => Boolean(m[7]));

  let dayFirst = true;
  if (opts.dayFirst) {
    dayFirst = true;
  } else if (opts.monthFirst) {
    dayFirst = false;
  } else {
    let dfValid = 0;
    let mfValid = 0;
    for (const m of sampled) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a > 12 && b > 12) continue; // not ambiguous
      const year = resolveYear(parseInt(m[3], 10));
      if (isValidYmd(year, b, a)) dfValid += 1; // a=day, b=month
      if (isValidYmd(year, a, b)) mfValid += 1; // b=day, a=month
    }
    dayFirst = dfValid >= mfValid; // tie -> day-first (A2)
  }

  return { dayFirst, is12h, example, overridden };
}

/**
 * Parse a (already-invisible-stripped) line prefix into a normalized timestamp,
 * honoring the file-level `detection`.
 *
 * Returns `null` when the line should be treated as a CONTINUATION:
 * - shape matched but the date is invalid (e.g. `31/02`, D-04)
 * - sanity window violated (year < 2009 or > currentYear+1, D-08)
 * `warnings` (optional) receives the reason for verbose reporting (D-07).
 */
export function tryParseTimestamp(
  line: string,
  detection: Detection = { dayFirst: true, is12h: false },
  warnings?: string[],
): ParsedTimestamp | null {
  const m = TS_RE.exec(line);
  if (!m) return null;

  const first = parseInt(m[1], 10);
  const second = parseInt(m[2], 10);
  const year = resolveYear(parseInt(m[3], 10));

  let hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = m[6] ? parseInt(m[6], 10) : 0;
  const ampm = m[7]?.toLowerCase();

  if (detection.is12h && ampm) {
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }

  const day = detection.dayFirst ? first : second;
  const month = detection.dayFirst ? second : first;

  if (year < SANITY_MIN_YEAR || year > new Date().getFullYear() + 1) {
    warnings?.push(`out-of-range date ignored: ${m[0]} (year ${year})`);
    return null;
  }

  if (!isValidYmd(year, month, day)) {
    warnings?.push(`invalid date treated as continuation: ${m[0]}`);
    return null;
  }

  const d = new Date(year, month - 1, day, hour, min, sec);
  const iso = format(d, "yyyy-MM-dd'T'HH:mm:ss");
  return { day, month, year, hour, min, sec, iso };
}

/** Convenience wrapper: parse or signal continuation via `null`. */
export function parseTimestamp(
  line: string,
  detection: Detection = { dayFirst: true, is12h: false },
  warnings?: string[],
): ParsedTimestamp | null {
  return tryParseTimestamp(line, detection, warnings);
}
