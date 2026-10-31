import { addPerson, expect, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * In-app reminders: a quiet card appears when no backup was made for a while (time is moved
 * forward with the browser clock), can be put off for a week, and is controlled from Settings.
 * Nothing leaves the device (the fixture fails on any foreign request).
 */
test('a backup reminder appears after the interval, can be snoozed, and is switched off in Settings', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  // The first look at a library with data starts the count.
  await page.goto('/en/');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByTestId('reminder-card')).toHaveCount(0);
  // The count starts once the (asynchronous) first look has stored its starting date: wait for it,
  // or a slow machine moves the clock before there is a date to count from.
  await page.waitForFunction(() => localStorage.getItem('memory-archive:reminders-state') !== null);

  await page.clock.install({ time: new Date(Date.now() + 15 * 86_400_000) });
  await page.goto('/en/');
  const card = page.getByTestId('reminder-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('You haven’t made a backup from this app in at least 14 days');
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.screenshot({ path: `.context/reminder-home-${testInfo.project.name}.png` });

  await card.getByRole('link', { name: 'Go to Backup and restore' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Backup and restore' })).toBeVisible();
  await expect(page.getByTestId('reminder-card')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  await page.getByTestId('reminder-card').getByRole('button', { name: 'Remind me later' }).click();
  await expect(page.getByTestId('reminder-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Backup and restore' })).toBeFocused();
  await page.goto('/en/');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByTestId('reminder-card')).toHaveCount(0);

  await page.goto('/en/settings/');
  const toggle = page.getByRole('switch', { name: /Show reminders/ });
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: `.context/reminder-settings-${testInfo.project.name}.png`, fullPage: true });
  await toggle.uncheck();
  await page.reload();
  await expect(page.getByRole('switch', { name: /Show reminders/ })).not.toBeChecked();
});
