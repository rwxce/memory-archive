import { strToU8, zipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * Notes against the built app, with the real workers and OPFS: a note is written on a message in the
 * conversation, shows in the person's Notes, is edited there; the person gets a note of their own;
 * one note is deleted (after asking); a reload keeps the rest. Set E2E_SHOTS=<dir> to save screenshots.
 */
const chat = [
  '[13/01/2026, 09:05:00] Ana: First hello',
  '[13/01/2026, 09:06:00] Bo: Second hello',
  '[14/02/2026, 21:30:00] Bo: Third hello',
].join('\n');
const zip = () => ({ name: 'WhatsApp Chat - Ana i Bo.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(chat) })) });

const article = (page: Page, position: number) => page.locator(`[role="feed"] article[aria-posinset="${position}"]`);
const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

test('write a note on a message, see and edit it in Notes, add a person note, delete one, reload keeps it', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();

  // empty first
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect(page).toHaveURL(/\/en\/person\/notes\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
  await expect(page.getByText('There are no notes about Mama yet.')).toBeVisible();

  // a note on the second message, in the conversation view
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await page.getByRole('link', { name: /Ana i Bo/ }).first().click();
  await expect(article(page, 3)).toBeVisible();
  const button = article(page, 2).getByRole('button', { name: 'Add a note' });
  expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  const before = (await article(page, 3).boundingBox())!.y;
  await button.click();
  const field = article(page, 2).getByLabel('Note about this message');
  await expect(field).toBeFocused();
  await field.fill('She hummed this one.\nEvery morning.');
  await field.press('ControlOrMeta+Enter');
  await expect(article(page, 2).getByText(/^Saved /)).toBeVisible();
  await expect(article(page, 2).getByRole('button', { name: 'Edit note' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/notes-message-${testInfo.project.name}.png` });
  await article(page, 2).getByRole('button', { name: 'Close' }).click();
  await expect(article(page, 2).getByLabel('Note about this message')).toHaveCount(0);
  await expect.poll(async () => (await article(page, 3).boundingBox())!.y).toBe(before);

  // it is in the person's Notes with the quoted message; edit it there
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  const cards = page.locator('main li.rounded-xl');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('She hummed this one.');
  await expect(cards.first()).toContainText('Second hello');
  await cards.first().getByRole('button', { name: 'Edit note' }).click();
  const edit = cards.first().getByLabel('Note about this message');
  await edit.fill('She hummed this one every morning.');
  await cards.first().getByRole('button', { name: 'Save note' }).click();
  await cards.first().getByRole('button', { name: 'Close' }).click();
  await expect(cards.first()).toContainText('She hummed this one every morning.');

  // a note on the person
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await page.getByLabel('Note about this person').fill('My mother.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText(/^Saved /)).toBeVisible();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/notes-person-${testInfo.project.name}.png`, fullPage: true });
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect(cards).toHaveCount(2);
  await expect(page.getByText('2 notes about Mama')).toBeVisible();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/notes-list-${testInfo.project.name}.png` });

  // delete the message note: asked first
  const message = cards.filter({ hasText: 'Second hello' });
  await message.getByRole('button', { name: 'Edit note' }).click();
  await message.getByRole('button', { name: 'Delete note' }).click();
  await message.getByRole('button', { name: 'Keep note' }).click();
  await message.getByRole('button', { name: 'Delete note' }).click();
  await message.getByRole('button', { name: 'Delete note' }).first().click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Note deleted.' })).toBeVisible();

  // a reload keeps the person's note and the deletion
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('My mother.');
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await page.getByRole('link', { name: /Ana i Bo/ }).first().click();
  await expect(article(page, 2).getByRole('button', { name: 'Add a note' })).toBeVisible();
});
