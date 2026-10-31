/**
 * Reminder preferences and bookkeeping, kept on this device only (localStorage, under the app's
 * `memory-archive:` prefix so "Erase everything" removes them). Two keys:
 *
 * - settings: the person's choices (on / off, how many days). They belong to the person, so they
 *   stay when a library is restored or replaced.
 * - state: what the app has seen about THIS library (when it was last backed up, when changes
 *   started waiting, snoozes). It carries the device id of the library it was written for and is
 *   dropped by the use case when that id differs, so a restored library never inherits it.
 *
 * Never holds names, text or file names. Unreadable or malformed values fall back to defaults.
 */

export type ReminderKind = 'backup' | 'sync';
export const REMINDER_KINDS: readonly ReminderKind[] = ['backup', 'sync'];

export const REMINDER_INTERVALS = [7, 14, 30] as const;
export type ReminderInterval = (typeof REMINDER_INTERVALS)[number];

export const REMINDER_SETTINGS_KEY = 'memory-archive:reminders';
export const REMINDER_STATE_KEY = 'memory-archive:reminders-state';

export interface ReminderSettings {
  enabled: boolean;
  intervalDays: ReminderInterval;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: true, intervalDays: 14 };

export interface KindState {
  /** ISO instant until which the reminder stays quiet. */
  snoozedUntil?: string;
  /** "Don't remind me": quiet until the person turns reminders off and on again in Settings. */
  off?: boolean;
}

export interface ReminderState {
  /** The device id of the library this was written for. */
  device: string;
  /** When this library was first seen with data; the start of the count when no backup was recorded. */
  baselineAt: string;
  /** The last full backup made here. */
  backupAt?: string;
  /** When changes first started waiting for a known device (cleared when nothing waits). */
  syncPendingSince?: string;
  backup: KindState;
  sync: KindState;
}

export type ReminderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Full ISO 8601 date-time with a zone (what `toISOString` writes); anything looser is treated as corrupt. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const isIso = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse rolls "02-30" over to March and accepts "24:00"; a real stored instant never does.
  const [year, month, day, hour, minute, second] = value.split(/\D/).map(Number) as [number, number, number, number, number, number];
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && hour <= 23 && minute <= 59 && second <= 59;
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function readJson(storage: ReminderStorage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(storage: ReminderStorage | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, full): reminders simply do not persist.
  }
}

export function readReminderSettings(storage: ReminderStorage | undefined): ReminderSettings {
  const raw = readJson(storage, REMINDER_SETTINGS_KEY);
  if (!isObject(raw)) return DEFAULT_REMINDER_SETTINGS;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_REMINDER_SETTINGS.enabled,
    intervalDays: (REMINDER_INTERVALS as readonly unknown[]).includes(raw.intervalDays)
      ? (raw.intervalDays as ReminderInterval)
      : DEFAULT_REMINDER_SETTINGS.intervalDays,
  };
}

export function writeReminderSettings(storage: ReminderStorage | undefined, settings: ReminderSettings): void {
  writeJson(storage, REMINDER_SETTINGS_KEY, settings);
}

function readKind(raw: unknown): KindState {
  if (!isObject(raw)) return {};
  return { ...(isIso(raw.snoozedUntil) ? { snoozedUntil: raw.snoozedUntil } : {}), ...(raw.off === true ? { off: true } : {}) };
}

export function readReminderState(storage: ReminderStorage | undefined): ReminderState | undefined {
  const raw = readJson(storage, REMINDER_STATE_KEY);
  if (!isObject(raw) || typeof raw.device !== 'string' || !isIso(raw.baselineAt)) return undefined;
  return {
    device: raw.device,
    baselineAt: raw.baselineAt,
    ...(isIso(raw.backupAt) ? { backupAt: raw.backupAt } : {}),
    ...(isIso(raw.syncPendingSince) ? { syncPendingSince: raw.syncPendingSince } : {}),
    backup: readKind(raw.backup),
    sync: readKind(raw.sync),
  };
}

export function writeReminderState(storage: ReminderStorage | undefined, state: ReminderState): void {
  writeJson(storage, REMINDER_STATE_KEY, state);
}

export function clearReminderState(storage: ReminderStorage | undefined): void {
  try {
    storage?.removeItem(REMINDER_STATE_KEY);
  } catch {
    // Nothing to clear.
  }
}
