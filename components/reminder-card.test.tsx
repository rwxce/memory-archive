import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import en from '@/messages/en.json';
import { REMINDER_SETTINGS_KEY, REMINDER_STATE_KEY } from '@/lib/storage/reminder-prefs';
import { getDeviceId } from '@/lib/usecases/sync-state';
import { populated, type Lib } from '@/lib/usecases/test-sync';
import { click, render, renderWithLibrary, settle, type Rendered } from './test-utils';
import { useLibrary } from '@/hooks/use-library';
import { ReminderCard as Card } from './reminder-card';
import { ReminderSettingsCard } from './reminder-settings-card';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const t = en.reminders;

/** The screens that show the card have opened the library already (`useLibrary`); the harness does the same. */
function ReminderCard(props: React.ComponentProps<typeof Card>) {
  useLibrary();
  return <Card {...props} />;
}
const card = (v: Rendered) => v.container.querySelector('[data-testid="reminder-card"]');
const button = (v: Rendered, name: string) => [...v.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

/** Pretends the library was last backed up long ago. */
async function seedOldBackup(lib: Lib, daysAgo = 40) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  window.localStorage.setItem(REMINDER_STATE_KEY, JSON.stringify({ device: await getDeviceId(lib.deps), baselineAt: at, backupAt: at, backup: {}, sync: {} }));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReminderCard', () => {
  test('shows nothing for a library that was never due, or an empty one', async () => {
    const lib = await populated();
    const view = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    expect(card(view)).toBeNull();
    view.unmount();
  });

  test('a due backup reminder is a calm card with the page-level actions only when asked for', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    const view = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    expect(card(view)?.textContent).toContain(t.backup.body.replace('{days}', '14'));
    expect(card(view)?.getAttribute('role')).toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
    expect(button(view, t.later)).toBeDefined();
    expect(button(view, t.never)).toBeDefined();
    view.unmount();

    const home = await renderWithLibrary(<ReminderCard kinds={['sync', 'backup']} link />, { lib });
    await settle();
    expect(home.container.querySelector('a')?.getAttribute('href')).toBe('/backup');
    home.unmount();
  });

  test('a kind the screen does not ask for is not shown', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    const view = await renderWithLibrary(<ReminderCard kinds={['sync']} />, { lib });
    await settle();
    expect(card(view)).toBeNull();
    view.unmount();
  });

  test('dismissing the card moves focus to the page heading, not the body', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    const view = await renderWithLibrary(
      <main>
        <h1 tabIndex={-1}>Backup</h1>
        <ReminderCard kinds={['backup']} />
      </main>,
      { lib },
    );
    await settle();
    const later = button(view, t.later);
    later?.focus();
    await click(later);
    expect(card(view)).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector('h1'));
    view.unmount();
  });

  test('"Remind me later" hides the card and stays quiet on the next visit', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    const view = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    await click(button(view, t.later));
    expect(card(view)).toBeNull();
    view.unmount();

    const again = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    expect(card(again)).toBeNull();
    again.unmount();
  });

  test('"Don\'t remind me" persists, and turning reminders off and on in Settings brings it back', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    const view = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    await click(button(view, t.never));
    expect(JSON.parse(window.localStorage.getItem(REMINDER_STATE_KEY)!).backup).toEqual({ off: true });
    view.unmount();

    const settings = await render(<ReminderSettingsCard />);
    const toggle = settings.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    await click(toggle); // off
    await click(toggle); // on
    settings.unmount();

    const again = await renderWithLibrary(<ReminderCard kinds={['backup']} />, { lib });
    await settle();
    expect(card(again)).not.toBeNull();
    again.unmount();
  });

  test('reminders switched off in Settings hide every card', async () => {
    const lib = await populated();
    await seedOldBackup(lib);
    window.localStorage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify({ enabled: false, intervalDays: 14 }));
    const view = await renderWithLibrary(<ReminderCard kinds={['backup', 'sync']} link />, { lib });
    await settle();
    expect(card(view)).toBeNull();
    view.unmount();
  });
});

describe('ReminderSettingsCard', () => {
  test('on by default, 14 days; choosing 30 days is stored on this device; off hides the interval', async () => {
    const view = await render(<ReminderSettingsCard />);
    const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(true);
    const radios = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    await click(radios[2]);
    expect(JSON.parse(window.localStorage.getItem(REMINDER_SETTINGS_KEY)!)).toEqual({ enabled: true, intervalDays: 30 });
    await click(toggle);
    expect(JSON.parse(window.localStorage.getItem(REMINDER_SETTINGS_KEY)!).enabled).toBe(false);
    expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
    view.unmount();
  });
});
