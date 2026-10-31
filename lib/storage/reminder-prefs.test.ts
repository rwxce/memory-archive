import { describe, expect, test } from 'vitest';
import { isIso, readReminderState, REMINDER_STATE_KEY } from './reminder-prefs';

const storageWith = (value: unknown) => ({
  getItem: () => JSON.stringify(value),
  setItem: () => undefined,
  removeItem: () => undefined,
});

describe('isIso', () => {
  test('accepts full ISO 8601 date-times with a zone', () => {
    for (const ok of ['2026-03-01T10:00:00Z', '2026-03-01T10:00:00.123Z', '2026-03-01T10:00:00+02:00']) expect(isIso(ok)).toBe(true);
  });
  test('rejects loose, impossible or non-string values', () => {
    for (const bad of ['', '2026', '2026-03-01', '2026-03-01T10:00:00', 'Mar 1 2026', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', 1e12, null, {}]) {
      expect(isIso(bad)).toBe(false);
    }
  });
});

describe('readReminderState', () => {
  test('drops corrupt dates and refuses a state without a valid baseline', () => {
    const base = { device: 'd', baselineAt: '2026-03-01T10:00:00Z', backup: {}, sync: {} };
    expect(readReminderState(storageWith({ ...base, backupAt: 'yesterday', syncPendingSince: '2026-03-01' }))).toEqual({ device: 'd', baselineAt: base.baselineAt, backup: {}, sync: {} });
    expect(readReminderState(storageWith({ ...base, baselineAt: 'soon' }))).toBeUndefined();
    expect(REMINDER_STATE_KEY).toBeTruthy();
  });
});
