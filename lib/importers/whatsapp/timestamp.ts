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
 * AM/PM forms: `AM` / `pm` (en), `a. m.` / `p. m.` (es, ca), with a normal,
 * no-break (U+00A0) or narrow no-break (U+202F, iOS) space — `\s` covers all.
 *
 * Captures: 1=day 2=month 3=year 4=hour 5=min 6=sec? 7=ampm?
 */
export const TS_RE =
  /^\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp]\.?\s?[Mm]\.?(?![A-Za-z]))?\]?/;

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
  /**
   * True when the day/month vote was a tie (every sampled date reads validly both ways, e.g. all
   * days <= 12) and no override was given: the order is a guess. Two exports of one chat could
   * then be read differently, so importers surface this instead of hiding it.
   */
  ambiguous?: boolean;
  /** When `ambiguous`: the first such date read both ways, `YYYY-MM-DD`. */
  preview?: { dayFirst: string; monthFirst: string };
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
 * Decide day/month order + 12h/24h for ONE file (PARSE-03), from ALL the lines given.
 *
 * - `--day-first` / `--month-first` short-circuit the vote (D-01).
 * - Otherwise: majority vote over every timestamped line that is not already settled
 *   by itself. A first component >= 13 can only be a day and a second one >= 13 can only be
 *   a day of a month-first date, so a single such line anywhere in the file settles the order
 *   (the vote counts how many lines are VALID under each reading); a tie defaults to
 *   DAY-FIRST (pt-BR, assumption A2), except when the clock uses upper-case `AM`/`PM` without
 *   dots: that is the en-US style, which writes month first (en-GB/AU write `am`/`pm`, es/ca
 *   write `p. m.`).
 * - `ambiguous`: the vote was a tie AND some line really reads as two different dates
 *   (`03/04/2026`); `preview` then holds both readings of the first such line.
 */
export function detectFormat(lines: Iterable<string>, opts: DetectOptions = {}): Detection {
  const detector = createFormatDetector();
  for (const line of lines) detector.add(line);
  return detector.result(opts);
}

export interface FormatDetector {
  /** Feed one transcript line (constant memory: only counters are kept). */
  add(line: string): void;
  /** True once at least one timestamp-shaped line was seen. */
  seenTimestamp(): boolean;
  result(opts?: DetectOptions): Detection;
}

export function createFormatDetector(): FormatDetector {
  let example: string | undefined;
  let seen = false;
  let is12h = false;
  let enUsClock = false;
  let dfValid = 0;
  let mfValid = 0;
  let preview: Detection['preview'];
  const pad = (n: number) => String(n).padStart(2, '0');

  return {
    add(line) {
      const s = stripInvisible(line);
      const m = TS_RE.exec(s);
      if (!m) return;
      if (!seen) example = s.slice(0, m[0].length);
      seen = true;
      if (m[7]) is12h = true;
      if (m[7] === 'AM' || m[7] === 'PM') enUsClock = true;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a > 12 && b > 12) return; // not ambiguous
      const year = resolveYear(parseInt(m[3], 10));
      if (isValidYmd(year, b, a)) dfValid += 1; // a=day, b=month
      if (isValidYmd(year, a, b)) mfValid += 1; // b=day, a=month
      if (a <= 12 && b <= 12 && a !== b && !preview && isValidYmd(year, b, a) && isValidYmd(year, a, b)) {
        preview = { dayFirst: `${year}-${pad(b)}-${pad(a)}`, monthFirst: `${year}-${pad(a)}-${pad(b)}` };
      }
    },
    seenTimestamp: () => seen,
    result(opts = {}) {
      const overridden = Boolean(opts.dayFirst || opts.monthFirst);
      let dayFirst: boolean;
      let ambiguous = false;
      if (opts.dayFirst) dayFirst = true;
      else if (opts.monthFirst) dayFirst = false;
      else if (dfValid !== mfValid) dayFirst = dfValid > mfValid;
      else {
        dayFirst = !enUsClock; // tie -> day-first (A2), unless en-US clock
        ambiguous = preview !== undefined;
      }
      return { dayFirst, is12h, example, overridden, ambiguous, ...(ambiguous ? { preview } : {}) };
    },
  };
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
  // `a. m.` / `PM` / `p.m.` -> 'a' | 'p'
  const ampm = m[7]?.[0].toLowerCase();

  if (detection.is12h && ampm) {
    if (ampm === 'p' && hour !== 12) hour += 12;
    if (ampm === 'a' && hour === 12) hour = 0;
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
