'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  dueReminders,
  getReminderSettings,
  setReminderSettings,
  snoozeReminder,
  turnOffReminder,
  type ReminderKind,
  type ReminderSettings,
} from '@/lib/usecases/reminders';
import { useLibraryInternals } from './use-library';

const storageOf = () => (typeof window === 'undefined' ? undefined : window.localStorage);

export interface Reminders {
  /** The reminder to show now, if any (one at a time, so the screen stays calm). */
  due: ReminderKind | undefined;
  snooze(kind: ReminderKind): void;
  turnOff(kind: ReminderKind): void;
}

/**
 * Which in-app reminder is due. `kinds` limits it to the ones that make sense on the screen;
 * change `refreshKey` to look again (after a changes file was handed over, for instance).
 */
export function useReminders(kinds: readonly ReminderKind[], refreshKey?: unknown): Reminders {
  const { state: library } = useLibraryInternals();
  const deps = library.status === 'ready' ? library.deps : undefined;
  const [dismissed, setDismissed] = useState<ReminderKind[]>([]);
  const [due, setDue] = useState<ReminderKind[]>([]);
  const wanted = kinds.join(',');

  useEffect(() => {
    if (!deps) return;
    let alive = true;
    dueReminders(deps, storageOf()).then((list) => alive && setDue(list));
    return () => {
      alive = false;
    };
  }, [deps, refreshKey]);

  const hide = useCallback((kind: ReminderKind) => setDismissed((d) => [...d, kind]), []);
  const snooze = useCallback(
    (kind: ReminderKind) => {
      snoozeReminder(storageOf(), kind);
      hide(kind);
    },
    [hide],
  );
  const turnOff = useCallback(
    (kind: ReminderKind) => {
      turnOffReminder(storageOf(), kind);
      hide(kind);
    },
    [hide],
  );

  const shown = due.find((kind) => wanted.split(',').includes(kind) && !dismissed.includes(kind));
  return { due: shown, snooze, turnOff };
}

/** The person's reminder choices (on / off, days), stored on this device. */
export function useReminderSettings(): [ReminderSettings, (patch: Partial<ReminderSettings>) => void] {
  const [settings, setSettings] = useState<ReminderSettings>(() => getReminderSettings(undefined));
  useEffect(() => {
    setSettings(getReminderSettings(storageOf()));
  }, []);
  const update = useCallback((patch: Partial<ReminderSettings>) => setSettings(setReminderSettings(storageOf(), patch)), []);
  return [settings, update];
}
