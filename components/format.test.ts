import { describe, expect, test } from 'vitest';
import { formatBytes, formatDateRange, formatFullDay, formatNames, formatWhen, initialsOf } from './format';

describe('formatBytes', () => {
  test('decimal units, one decimal below 10, localized separators', () => {
    expect(formatBytes(0, 'en')).toBe('0 byte');
    expect(formatBytes(1_234_567, 'en')).toBe('1.2 MB');
    expect(formatBytes(45_000_000_000, 'en')).toBe('45 GB');
    expect(formatBytes(1_234_567, 'ca')).toMatch(/^1,2\sMB$/);
  });
});

describe('initialsOf', () => {
  test('first letters of the first and last word, upper-cased', () => {
    expect(initialsOf('Ana')).toBe('A');
    expect(initialsOf('  ana maria puig ')).toBe('AP');
    expect(initialsOf('émile zola')).toBe('ÉZ');
  });

  test('never cuts a character in half and never returns an empty string', () => {
    expect(initialsOf('🌻 Sunflower')).toBe('🌻S');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});

describe('formatDateRange', () => {
  test('one day, a span, or nothing; wall-clock dates are never shifted by a timezone', () => {
    expect(formatDateRange('2024-03-12T00:05:00', '2024-03-12T23:59:00', 'en')).toBe('Mar 12, 2024');
    expect(formatDateRange('2024-03-12T09:00:00', '2025-07-03T10:00:00', 'en')).toBe('Mar 12, 2024 – Jul 3, 2025');
    expect(formatDateRange(null, null, 'en')).toBe('');
  });
});

describe('formatNames', () => {
  test('joins names the way the language does', () => {
    expect(formatNames(['Ana', 'Bo', 'Cy'], 'en')).toBe('Ana, Bo, and Cy');
    expect(formatNames(['Ana', 'Bo'], 'es')).toBe('Ana y Bo');
    expect(formatNames(['Ana', 'Bo', 'Cy'], 'en', true)).toBe('Ana, Bo, Cy');
  });
});

describe('formatWhen', () => {
  const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;

  test('says how long ago in the language, with the exact date next to it', () => {
    expect(formatWhen(ago(10_000), 'en', NOW).relative).toBe('now');
    expect(formatWhen(ago(5 * MIN), 'en', NOW).relative).toBe('5 minutes ago');
    expect(formatWhen(ago(3 * 60 * MIN), 'en', NOW).relative).toBe('3 hours ago');
    expect(formatWhen(ago(1 * DAY), 'en', NOW).relative).toBe('yesterday');
    expect(formatWhen(ago(3 * DAY), 'es', NOW).relative).toBe('hace 3 días');
    expect(formatWhen(ago(70 * DAY), 'ca', NOW).relative).toBe('fa 2 mesos');
    expect(formatWhen(ago(800 * DAY), 'en', NOW).relative).toBe('2 years ago');
    expect(formatWhen(ago(3 * DAY), 'en', NOW).absolute).toMatch(/^Jun 12, 2026/);
  });

  test('a moment in the future reads as now', () => {
    expect(formatWhen(new Date(NOW + 5 * MIN).toISOString(), 'en', NOW).relative).toBe('now');
  });
});

describe('formatFullDay', () => {
  test('the weekday and the whole date in the UI language, never shifted by a timezone', () => {
    expect(formatFullDay('2026-03-17T00:05:00', 'en')).toBe('Tuesday, March 17, 2026');
    expect(formatFullDay('2026-03-17', 'es')).toMatch(/^martes,? 17 de marzo de 2026$/);
    expect(formatFullDay('2026-03-17T23:59:59', 'ca')).toMatch(/dimarts.*17.*març.*2026/);
  });
});
