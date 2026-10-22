import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectFormat, parseTimestamp, resolveYear, trimInvisible, TS_RE } from './timestamp';

test('12h detection: PM token converts to 24h (D-02)', () => {
  // Day 13 keeps the order unambiguous (an all-ambiguous en-US "PM" sample now reads month-first).
  const line = '[13/02/2026, 03:04:05 PM] Name: x';
  const det = detectFormat([line]);
  assert.equal(det.is12h, true);
  const ts = parseTimestamp(line, det)!;
  assert.equal(ts.hour, 15);
  assert.equal(ts.iso, '2026-02-13T15:04:05');
});

test('12h edge cases: 12PM stays 12, 12AM becomes 0 (D-02)', () => {
  const det = { dayFirst: true, is12h: true };
  assert.equal(parseTimestamp('[10/06/2026, 12:00:00 PM] N: x', det)!.hour, 12);
  assert.equal(parseTimestamp('[10/06/2026, 12:30:00 AM] N: x', det)!.hour, 0);
});

test('day/month majority vote (D-01)', () => {
  // Majority DD/MM: only 25 can be a day.
  const ddmm = [
    '[25/12/2026, 10:00:00] A: x',
    '[25/11/2026, 10:00:00] A: x',
    '[25/01/2027, 10:00:00] A: x',
    '[03/04/2026, 10:00:00] A: x', // ambiguous
    '[05/06/2026, 10:00:00] A: x', // ambiguous
  ];
  assert.equal(detectFormat(ddmm).dayFirst, true);

  // Majority MM/DD: only 12 can be a month.
  const mmdd = [
    '[12/25/2026, 10:00:00] A: x',
    '[11/25/2026, 10:00:00] A: x',
    '[01/25/2027, 10:00:00] A: x',
    '[04/03/2026, 10:00:00] A: x',
    '[06/05/2026, 10:00:00] A: x',
  ];
  assert.equal(detectFormat(mmdd).dayFirst, false);

  // Tie defaults to day-first (pt-BR, A2).
  const tie = ['[03/04/2026, 10:00:00] A: x'];
  assert.equal(detectFormat(tie).dayFirst, true);
});

test('CLI overrides short-circuit the vote (D-01)', () => {
  const mmdd = ['[12/25/2026, 10:00:00] A: x', '[11/25/2026, 10:00:00] A: x'];
  assert.equal(detectFormat(mmdd, { dayFirst: true }).dayFirst, true);
  assert.equal(detectFormat(mmdd, { monthFirst: true }).overridden, true);
  const ddmm = ['[25/12/2026, 10:00:00] A: x', '[25/11/2026, 10:00:00] A: x'];
  assert.equal(detectFormat(ddmm, { monthFirst: true }).dayFirst, false);
});

test('invalid date -> null continuation signal (D-04)', () => {
  assert.equal(
    parseTimestamp('[31/02/2026, 10:00:00] Name: x'),
    null,
  );
});

test('sanity window: year < 2009 or > curYear+1 -> null (D-08)', () => {
  assert.equal(parseTimestamp('[01/01/2099, 10:00:00] Name: x'), null);
  assert.equal(parseTimestamp('[01/01/2005, 10:00:00] Name: x'), null);
  assert.ok(parseTimestamp('[01/01/2026, 10:00:00] Name: x'));
});

test('2-digit sliding window (D-05)', () => {
  // Pure window math: threshold is currentYear-2000+1.
  const cur = new Date().getFullYear();
  assert.equal(resolveYear(cur - 2000), 2000 + (cur - 2000));
  assert.equal(resolveYear(cur - 2000 + 1), 2000 + (cur - 2000 + 1));
  assert.equal(resolveYear(26), 2026);
  // 99 resolves to 1999 by the window — then the D-08 sanity gate rejects it
  // at the parse level (pre-2009 => continuation signal).
  assert.equal(resolveYear(99), 1999);
  assert.equal(parseTimestamp('[15/08/99, 10:00:00] N: x'), null);
  assert.ok(parseTimestamp('[15/08/26, 10:00:00] N: x'));
});

test('Android style without brackets still parses (D-03)', () => {
  const ts = parseTimestamp('15/08/2026, 10:00:00 Name: x')!;
  assert.equal(ts.iso, '2026-08-15T10:00:00');
});

test('separator variants . - / all accepted (D-03)', () => {
  for (const sep of ['.', '-', '/']) {
    const line = `15${sep}08${sep}2026, 10:00:00 N: x`;
    assert.equal(parseTimestamp(line)!.iso, '2026-08-15T10:00:00', sep);
  }
});

test('12h variants: a. m. / p. m. / p.m. with normal, no-break and narrow no-break spaces', () => {
  const det = { dayFirst: true, is12h: true };
  for (const [ampm, hour] of [
    ['p. m.', 21],
    ['p.\u00a0m.', 21],
    ['p.m.', 21],
    ['\u202fPM', 21],
    ['a. m.', 9],
    ['\u202fam', 9],
  ] as const) {
    const sep = ampm.startsWith('\u202f') ? '' : ' ';
    const ts = parseTimestamp(`31/12/25, 9:41${sep}${ampm} - Ana: x`, det);
    assert.equal(ts?.hour, hour, JSON.stringify(ampm));
  }
});

test('12h token is not taken from a name starting with "Am"/"Pm"', () => {
  const m = TS_RE.exec('[01/02/2026, 10:00:00] Amy: hi')!;
  assert.equal(m[7], undefined);
  assert.equal(detectFormat(['01/02/2026, 10:00 - Pmela: hi']).is12h, false);
});

test('ambiguous dates: upper-case AM/PM (en-US) reads month-first; other clocks day-first', () => {
  assert.equal(detectFormat(['1/2/26, 9:41 PM - A: x', '3/4/26, 9:41 AM - A: x']).dayFirst, false);
  assert.equal(detectFormat([`[1/2/26, 9:41:00\u202fPM] A: x`]).dayFirst, false);
  assert.equal(detectFormat(['1/2/26, 9:41 pm - A: x']).dayFirst, true); // en-GB/AU style
  assert.equal(detectFormat(['1/2/26, 9:41 p. m. - A: x']).dayFirst, true); // es
  assert.equal(detectFormat(['1/2/26, 21:41 - A: x']).dayFirst, true); // 24h
  // An unambiguous date still wins over the clock style.
  assert.equal(detectFormat(['13/2/26, 9:41 PM - A: x']).dayFirst, true);
});

test('TS_RE has no seconds group when absent — sec defaults to 0', () => {
  const m = TS_RE.exec('[23/07/2026, 09:47] N: x')!;
  assert.equal(m[6], undefined);
  assert.equal(parseTimestamp('[23/07/2026, 09:47] N: x')!.sec, 0);
});

test('detectFormat reports a tie as ambiguous, evidence and overrides as not', () => {
  const tie = ['[03/04/2026, 10:00:00] A: x', '[05/06/2026, 10:00:00] A: x'];
  assert.equal(detectFormat(tie).ambiguous, true);
  assert.equal(detectFormat([...tie, '[25/12/2026, 10:00:00] A: x']).ambiguous, false);
  assert.equal(detectFormat(tie, { monthFirst: true }).ambiguous, false);
  assert.equal(detectFormat([]).ambiguous, false);
});

test('detectFormat uses the whole transcript, not the first 50 dates', () => {
  const lines = Array.from({ length: 80 }, () => '[03/04/2026, 10:00:00] A: x');
  assert.equal(detectFormat(lines).ambiguous, true);
  assert.deepEqual(detectFormat(lines).preview, { dayFirst: '2026-04-03', monthFirst: '2026-03-04' });
  assert.equal(detectFormat([...lines, '[03/25/2026, 10:00:00] A: x']).dayFirst, false); // month 25 is impossible
  assert.equal(detectFormat([...lines, '[25/03/2026, 10:00:00] A: x']).dayFirst, true);
  assert.equal(detectFormat([...lines, '[25/03/2026, 10:00:00] A: x']).ambiguous, false);
  // Lines that read the same either way (05/05) are no ambiguity at all.
  assert.equal(detectFormat(['[05/05/2026, 10:00:00] A: x']).ambiguous, false);
});

/** Adversarial input must finish fast: these used to take seconds (quadratic regexes). */
const MAX_MS = 50;
const N = 60_000;
const elapsed = (fn: () => unknown): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

test('trimInvisible: linear time, same result', () => {
  const run = '\u200e'.repeat(N);
  assert.ok(elapsed(() => trimInvisible(`${run}x${run}x`)) < MAX_MS);
  assert.ok(elapsed(() => trimInvisible(`x${run}`)) < MAX_MS);
  assert.equal(trimInvisible('\u200e\ufeffa\u200e b\u200b\u2069'), 'a\u200e b');
  assert.equal(trimInvisible('\u200e\u200f'), '');
  assert.equal(trimInvisible(''), '');
});
