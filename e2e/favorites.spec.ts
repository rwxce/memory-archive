import { strToU8, zipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { addPerson, backToPerson, expect, openSection, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * Favorite messages against the built app, with the real workers and OPFS: a small synthetic chat is
 * imported into a person, a message is starred from the person's Timeline and another in the
 * conversation, both show on the person's Favorites screen (chronological, linked to their day),
 * one is removed there, and a reload keeps all of it. Set E2E_SHOTS=<dir> to also save screenshots.
 */
const chat = [
  '[10/01/2026, 09:05:00] Ana: First hello',
  '[10/01/2026, 09:06:00] Bo: Second hello',
  '[11/02/2026, 21:30:00] Bo: Third hello',
  '[14/03/2026, 18:00:00] Ana: Fourth hello',
].join('\n');
const zip = () => ({ name: 'WhatsApp Chat - Ana i Bo.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(chat) })) });

const article = (page: Page, position: number) => page.locator(`[role="feed"] article[aria-posinset="${position}"]`);
const starOf = (page: Page, position: number) => article(page, position).getByRole('button', { name: /favorites$/ });

test('star a message in the Timeline and in the conversation; both appear in Favorites, one is removed, a reload keeps it', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();

  // empty first
  await openSection(page, 'Favorites');
  await expect(page).toHaveURL(/\/en\/person\/favorites\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Favorites' })).toBeVisible();
  await expect(page.getByText('Mama has no favorite messages yet.')).toBeVisible();
  await expect(page.getByText('press the star beside a message')).toBeVisible();

  // star the third message from the timeline
  await backToPerson(page, 'Mama');
  await openSection(page, 'Timeline');
  await expect(article(page, 4)).toBeInViewport();
  const star = starOf(page, 3);
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(star).toHaveAccessibleName('Add to favorites');
  const box = await article(page, 3).boundingBox();
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toHaveAccessibleName('Remove from favorites');
  expect((await article(page, 3).boundingBox())!.height).toBe(box!.height);
  expect((await star.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  expect(await overflowsHorizontally(page)).toBe(false);

  // it is in Favorites, linked to its day; star another in the conversation itself
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await openSection(page, 'Favorites');
  const items = page.locator('section li');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Third hello');
  await expect(items.first()).toContainText('Feb 11, 2026, 9:30 PM');
  await items.first().getByRole('link', { name: /^Open in conversation/ }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-02-11&message=[0-9]+&back=favorites$/);
  await expect(starOf(page, 3)).toHaveAttribute('aria-pressed', 'true');
  await expect(article(page, 4)).toBeInViewport();
  await starOf(page, 1).click();
  await expect(starOf(page, 1)).toHaveAttribute('aria-pressed', 'true');
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/favorites-conversation-${testInfo.project.name}.png` });

  // two favorites, oldest first; remove one from the list
  // Back returns to the favorites it was opened from.
  await page.getByRole('link', { name: "Back to Mama's favorites" }).click();
  await expect(page).toHaveURL(/\/en\/person\/favorites\/\?id=[0-9a-f-]{36}$/);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('First hello');
  await expect(items.nth(1)).toContainText('Third hello');
  await expect(page.getByText('2 favorite messages')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/favorites-${testInfo.project.name}.png` });
  await items.nth(0).getByRole('button', { name: 'Remove from favorites' }).click();
  await expect(items).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Removed from favorites' })).toBeVisible();

  // a reload keeps it; the removed message is a plain message again, the other still starred
  await page.reload();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Third hello');
  await items.first().getByRole('link', { name: /^Open in conversation/ }).click();
  await expect(starOf(page, 3)).toHaveAttribute('aria-pressed', 'true');
  await expect(starOf(page, 1)).toHaveAttribute('aria-pressed', 'false');
});
