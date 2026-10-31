import { describe, expect, test } from 'vitest';
import { currentChangeSeq, renewDevice } from '../db/sync';
import { REMINDER_STATE_KEY } from '../storage/reminder-prefs';
import {
  dueReminders,
  getReminderSettings,
  recordBackupMade,
  setReminderSettings,
  snoozeReminder,
  turnOffReminder,
} from './reminders';
import { recordReceived, recordSent } from './sync-state';
import { createTestLibrary } from './test-client';
import { populated } from './test-sync';

const PEER = '00000000-0000-4000-8000-000000000900';
const T0 = new Date('2026-03-01T10:00:00Z');
const after = (days: number) => new Date(T0.getTime() + days * 86_400_000);

/** A localStorage stand-in. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('reminders', () => {
  test('an empty library never has a reminder and nothing is written', async () => {
    const { deps } = await createTestLibrary();
    const storage = memoryStorage();
    expect(await dueReminders(deps, storage, after(400))).toEqual([]);
    expect(storage.map.size).toBe(0);
  });

  test('defaults: on, 14 days; a backup reminder comes only after the interval', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    expect(getReminderSettings(storage)).toEqual({ enabled: true, intervalDays: 14 });
    expect(await dueReminders(lib.deps, storage, T0)).toEqual([]);
    expect(await dueReminders(lib.deps, storage, after(13))).toEqual([]);
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual(['backup']);
  });

  test('making a backup restarts the count', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await dueReminders(lib.deps, storage, T0);
    expect(await dueReminders(lib.deps, storage, after(20))).toEqual(['backup']);
    await recordBackupMade(lib.deps, storage, after(20));
    expect(await dueReminders(lib.deps, storage, after(33))).toEqual([]);
    expect(await dueReminders(lib.deps, storage, after(34))).toEqual(['backup']);
  });

  test('"remind me later" is quiet for 7 days and survives a reload; "don\'t remind me" stays quiet', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await dueReminders(lib.deps, storage, T0);
    expect(await dueReminders(lib.deps, storage, after(15))).toEqual(['backup']);
    snoozeReminder(storage, 'backup', after(15));
    expect(await dueReminders(lib.deps, storage, after(21))).toEqual([]);
    expect(await dueReminders(lib.deps, storage, after(22))).toEqual(['backup']);
    turnOffReminder(storage, 'backup');
    expect(await dueReminders(lib.deps, storage, after(300))).toEqual([]);
  });

  test('turning reminders off hides everything; turning them on again forgets "don\'t remind me"', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await dueReminders(lib.deps, storage, T0);
    turnOffReminder(storage, 'backup');
    setReminderSettings(storage, { enabled: false });
    expect(await dueReminders(lib.deps, storage, after(100))).toEqual([]);
    setReminderSettings(storage, { enabled: true });
    expect(await dueReminders(lib.deps, storage, after(100))).toEqual(['backup']);
  });

  test('the interval is a choice of 7, 14 or 30 days; anything else is ignored', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    setReminderSettings(storage, { intervalDays: 7 });
    await dueReminders(lib.deps, storage, T0);
    expect(await dueReminders(lib.deps, storage, after(7))).toEqual(['backup']);
    storage.setItem('memory-archive:reminders', JSON.stringify({ enabled: true, intervalDays: 3 }));
    expect(getReminderSettings(storage).intervalDays).toBe(14);
    storage.setItem('memory-archive:reminders', 'not json');
    expect(getReminderSettings(storage)).toEqual({ enabled: true, intervalDays: 14 });
  });

  test('changes waiting for a known device are due after the interval, and clear once they were handed over', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await recordReceived(lib.deps, PEER, 3, null);
    expect(await dueReminders(lib.deps, storage, T0)).toEqual([]);
    await recordBackupMade(lib.deps, storage, after(10));
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual(['sync']);
    await recordSent(lib.deps, PEER, currentChangeSeq(lib.opened.db));
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual([]);
    expect(JSON.parse(storage.getItem(REMINDER_STATE_KEY)!)).not.toHaveProperty('syncPendingSince');
  });

  test('a peer not exchanged with for over 90 days no longer keeps the changes reminder alive', async () => {
    const lib = await populated();
    const deps = { ...lib.deps, now: () => T0 };
    const storage = memoryStorage();
    await recordReceived(deps, PEER, 3, null); // exchanged at T0; this device never sent anything to it
    expect(await dueReminders(deps, storage, T0)).toEqual([]); // changes start waiting
    await recordBackupMade(deps, storage, after(89)); // keeps the backup reminder out of the way
    expect(await dueReminders(deps, storage, after(90))).toEqual(['sync']); // exactly 90 days: still in play
    expect(await dueReminders(deps, storage, after(91))).toEqual([]); // stale
    expect(JSON.parse(storage.getItem(REMINDER_STATE_KEY)!)).not.toHaveProperty('syncPendingSince');
  });

  test('a recent exchange brings the peer back in', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await recordReceived({ ...lib.deps, now: () => T0 }, PEER, 3, null);
    await recordBackupMade(lib.deps, storage, after(120));
    expect(await dueReminders(lib.deps, storage, after(120))).toEqual([]); // stale peer: nothing waiting
    await recordReceived({ ...lib.deps, now: () => after(120) }, PEER, 4, null);
    expect(await dueReminders(lib.deps, storage, after(121))).toEqual([]); // waiting since now
    expect(await dueReminders(lib.deps, storage, after(135))).toContain('sync');
  });

  test('instants in the future (a clock that went back) are clamped to now, not trusted', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await dueReminders(lib.deps, storage, after(100));
    const state = JSON.parse(storage.getItem(REMINDER_STATE_KEY)!);
    storage.setItem(REMINDER_STATE_KEY, JSON.stringify({ ...state, baselineAt: after(500).toISOString(), backupAt: after(500).toISOString() }));
    // Treated as "now": not due yet, and due again one interval after, never held off for 400 days.
    expect(await dueReminders(lib.deps, storage, after(101))).toEqual([]);
    const fixed = JSON.parse(storage.getItem(REMINDER_STATE_KEY)!);
    expect(Date.parse(fixed.baselineAt)).toBeLessThanOrEqual(after(101).getTime());
    expect(Date.parse(fixed.backupAt)).toBeLessThanOrEqual(after(101).getTime());
    expect(await dueReminders(lib.deps, storage, after(101 + 14))).toEqual(['backup']);
  });

  test('a waiting-since date in the future restarts the count from now, it does not hold the reminder off', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await recordReceived(lib.deps, PEER, 3, null);
    await recordBackupMade(lib.deps, storage, after(10));
    await dueReminders(lib.deps, storage, T0);
    const state = JSON.parse(storage.getItem(REMINDER_STATE_KEY)!);
    storage.setItem(REMINDER_STATE_KEY, JSON.stringify({ ...state, syncPendingSince: after(900).toISOString() }));
    expect(await dueReminders(lib.deps, storage, after(14))).not.toContain('sync');
    expect(await dueReminders(lib.deps, storage, after(28))).toContain('sync');
  });

  test('a snooze ending later than a snooze can last counts as expired; a normal one still holds', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await recordBackupMade(lib.deps, storage, T0);
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual(['backup']);
    const state = JSON.parse(storage.getItem(REMINDER_STATE_KEY)!);
    storage.setItem(REMINDER_STATE_KEY, JSON.stringify({ ...state, backup: { snoozedUntil: after(14 + 400).toISOString() } }));
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual(['backup']);
    storage.setItem(REMINDER_STATE_KEY, JSON.stringify({ ...state, backup: { snoozedUntil: after(14 + 6).toISOString() } }));
    expect(await dueReminders(lib.deps, storage, after(14))).toEqual([]);
  });

  test('corrupt stored dates are ignored, never trusted', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await dueReminders(lib.deps, storage, T0);
    const state = JSON.parse(storage.getItem(REMINDER_STATE_KEY)!);
    for (const bad of ['soon', '2026', '2026-03-01', 'Mar 1 2026', '2026-13-45T00:00:00Z', 12345, null]) {
      storage.setItem(REMINDER_STATE_KEY, JSON.stringify({ ...state, backupAt: bad, backup: { snoozedUntil: bad } }));
      expect(await dueReminders(lib.deps, storage, after(14))).toEqual(['backup']);
    }
  });

  test('checking reminders never writes to the library: no device row is created, nothing is stamped', async () => {
    const lib = await populated();
    const { db } = lib.opened;
    db.run('DELETE FROM device');
    const storage = memoryStorage();
    const before = db.all('SELECT * FROM device');
    expect(await dueReminders(lib.deps, storage, after(100))).toEqual([]);
    await recordBackupMade(lib.deps, storage, after(100));
    expect(db.all('SELECT * FROM device')).toEqual(before);
    expect(db.all('SELECT count(*) AS n FROM device')).toEqual([{ n: 0 }]);
    expect(storage.map.size).toBe(0);
  });

  test('a database that rejects writes still answers the check (read-only path)', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    expect(await dueReminders(lib.deps, storage, T0)).toEqual([]);
    lib.opened.db.exec('PRAGMA query_only = ON');
    expect(await dueReminders(lib.deps, storage, after(20))).toEqual(['backup']);
    await recordBackupMade(lib.deps, storage, after(20));
    expect(await dueReminders(lib.deps, storage, after(21))).toEqual([]);
  });

  test('without a known device there is no sync reminder', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    await recordBackupMade(lib.deps, storage, T0);
    expect(await dueReminders(lib.deps, storage, after(10))).toEqual([]);
  });

  test('a restored library does not inherit snoozes, "don\'t remind me" or the last backup, but keeps the choices', async () => {
    const lib = await populated();
    const storage = memoryStorage();
    setReminderSettings(storage, { intervalDays: 7 });
    await recordBackupMade(lib.deps, storage, T0);
    turnOffReminder(storage, 'backup');
    expect(await dueReminders(lib.deps, storage, after(30))).toEqual([]);

    renewDevice(lib.opened.db, currentChangeSeq(lib.opened.db)); // what a restore or replace does
    expect(await dueReminders(lib.deps, storage, after(30))).toEqual([]); // counting starts again here...
    expect(await dueReminders(lib.deps, storage, after(37))).toEqual(['backup']); // ...and the old "off" is gone
    expect(getReminderSettings(storage).intervalDays).toBe(7);
  });

  test('storage that cannot be written never breaks the check (nothing can be counted, so nothing is due)', async () => {
    const lib = await populated();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(await dueReminders(lib.deps, broken, after(100))).toEqual([]);
  });
});
