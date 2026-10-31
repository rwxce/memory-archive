import {
  clearReminderState,
  readReminderSettings,
  readReminderState,
  writeReminderSettings,
  writeReminderState,
  type KindState,
  type ReminderInterval,
  type ReminderKind,
  type ReminderSettings,
  type ReminderState,
  type ReminderStorage,
} from '../storage/reminder-prefs';
import type { LibraryDeps } from './profiles';
import { countUnsentChanges, peekDeviceId } from './sync-state';

export type { ReminderInterval, ReminderKind, ReminderSettings, ReminderStorage };
export { DEFAULT_REMINDER_SETTINGS, REMINDER_INTERVALS, REMINDER_KINDS } from '../storage/reminder-prefs';

/*
 * Calm, in-app reminders (roadmap phase 7, "export reminders"): a card shown inside the app when
 * (a) changes made here have not been handed to a device this one has exchanged files with, or
 * (b) no full backup was made here for a while. Everything is local: it is evaluated when a screen
 * opens, from the library and from small preferences in localStorage. No notification, push,
 * timer, network or telemetry exists for it. A restored or replaced library is a new device (new
 * id), so the bookkeeping written for the old one is dropped and counting starts again.
 */

/** "Remind me later" length. */
export const SNOOZE_DAYS = 7;
const DAY_MS = 86_400_000;

/** A peer not exchanged with for this long no longer keeps the "changes waiting" reminder alive. */
export const STALE_PEER_DAYS = 90;

const addDays = (from: Date, days: number): string => new Date(from.getTime() + days * DAY_MS).toISOString();
const elapsedDays = (since: string, now: Date): number => (now.getTime() - Date.parse(since)) / DAY_MS;

export function getReminderSettings(storage: ReminderStorage | undefined): ReminderSettings {
  return readReminderSettings(storage);
}

/**
 * Saves the person's choices. Turning reminders back ON forgets earlier "Don't remind me" and
 * snoozes: it is the way back from them.
 */
export function setReminderSettings(storage: ReminderStorage | undefined, patch: Partial<ReminderSettings>): ReminderSettings {
  const before = readReminderSettings(storage);
  const next: ReminderSettings = { ...before, ...patch };
  writeReminderSettings(storage, next);
  if (patch.enabled === true && !before.enabled) {
    const state = readReminderState(storage);
    if (state) writeReminderState(storage, { ...state, backup: {}, sync: {} });
  }
  return next;
}

/** An instant that cannot be later than `now` (a clock that went back, or a bad value). */
const notAfter = (iso: string, now: Date): string => (Date.parse(iso) > now.getTime() ? now.toISOString() : iso);

/** A snooze is at most `SNOOZE_DAYS` long; a later end can only come from a wrong clock or a bad value. */
const sane = (kind: KindState, now: Date): KindState => {
  const { snoozedUntil, ...rest } = kind;
  return snoozedUntil !== undefined && Date.parse(snoozedUntil) > now.getTime() + SNOOZE_DAYS * DAY_MS ? rest : kind;
};

/**
 * The state for this library, starting fresh when it was written for another one. Instants later
 * than `now` (the clock went back) are brought back to `now`, so a count never goes negative and
 * a reminder is never held off by a date in the future.
 */
function stateFor(storage: ReminderStorage | undefined, deviceId: string, now: Date): ReminderState {
  const stored = readReminderState(storage);
  if (!stored || stored.device !== deviceId) return { device: deviceId, baselineAt: now.toISOString(), backup: {}, sync: {} };
  return {
    ...stored,
    baselineAt: notAfter(stored.baselineAt, now),
    ...(stored.backupAt ? { backupAt: notAfter(stored.backupAt, now) } : {}),
    ...(stored.syncPendingSince ? { syncPendingSince: notAfter(stored.syncPendingSince, now) } : {}),
    backup: sane(stored.backup, now),
    sync: sane(stored.sync, now),
  };
}

const quiet = (kind: KindState, now: Date): boolean =>
  kind.off === true ||
  (kind.snoozedUntil !== undefined && Date.parse(kind.snoozedUntil) > now.getTime() && Date.parse(kind.snoozedUntil) <= now.getTime() + SNOOZE_DAYS * DAY_MS);

/**
 * Which reminders are due now, in the order to show them (changes waiting first). Empty when
 * reminders are off, when the library has no data at all, or when nothing is due. It may update
 * the bookkeeping (first seen with data, changes started waiting, changes no longer waiting).
 * Failures reading the library mean "nothing due": a reminder never gets in the way.
 */
export async function dueReminders(deps: LibraryDeps, storage: ReminderStorage | undefined, now: Date = new Date()): Promise<ReminderKind[]> {
  const settings = readReminderSettings(storage);
  if (!settings.enabled) return [];
  try {
    if (await deps.client.call('isLibraryEmpty')) return [];
    // Read-only: a reminder check never creates the device row (no write outside the archive guard).
    const deviceId = await peekDeviceId(deps);
    if (deviceId === null) return [];
    const unsent = await countUnsentChanges(deps);
    const state = stateFor(storage, deviceId, now);
    // Only peers still in play count: exchanged with in the last 90 days. A peer this device only
    // receives from (never sent to) would otherwise make the whole library "unsent" for good.
    const live = (p: (typeof unsent)[number]): boolean => p.lastExchangeAt !== null && elapsedDays(p.lastExchangeAt, now) <= STALE_PEER_DAYS;
    const waiting = unsent.some((p) => live(p) && p.count > 0);
    if (waiting && !state.syncPendingSince) state.syncPendingSince = now.toISOString();
    if (!waiting) delete state.syncPendingSince;
    writeReminderState(storage, state);

    const due: ReminderKind[] = [];
    if (waiting && state.syncPendingSince && !quiet(state.sync, now) && elapsedDays(state.syncPendingSince, now) >= settings.intervalDays) due.push('sync');
    if (!quiet(state.backup, now) && elapsedDays(state.backupAt ?? state.baselineAt, now) >= settings.intervalDays) due.push('backup');
    return due;
  } catch {
    return [];
  }
}

/** A full backup file was just made on this device. */
export async function recordBackupMade(deps: LibraryDeps, storage: ReminderStorage | undefined, now: Date = new Date()): Promise<void> {
  try {
    const deviceId = await peekDeviceId(deps);
    if (deviceId === null) return;
    const state = stateFor(storage, deviceId, now);
    writeReminderState(storage, { ...state, backupAt: now.toISOString(), backup: { ...state.backup, snoozedUntil: undefined } });
  } catch {
    // The backup itself succeeded; only the reminder bookkeeping is skipped.
  }
}

/** "Remind me later": quiet for 7 days. Needs the state `dueReminders` wrote when it showed the card. */
export function snoozeReminder(storage: ReminderStorage | undefined, kind: ReminderKind, now: Date = new Date()): void {
  const state = readReminderState(storage);
  if (state) writeReminderState(storage, { ...state, [kind]: { ...state[kind], snoozedUntil: addDays(now, SNOOZE_DAYS) } });
}

/** "Don't remind me" for one kind, until reminders are turned off and on again in Settings. */
export function turnOffReminder(storage: ReminderStorage | undefined, kind: ReminderKind): void {
  const state = readReminderState(storage);
  if (state) writeReminderState(storage, { ...state, [kind]: { off: true } });
}

/** Forgets the bookkeeping (not the person's choices). */
export function forgetReminderState(storage: ReminderStorage | undefined): void {
  clearReminderState(storage);
}
