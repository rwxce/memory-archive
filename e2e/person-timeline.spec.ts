import { strToU8, zipSync } from 'fflate';
import type { Locator, Page } from '@playwright/test';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * A person's Timeline against the built app, with the real workers and OPFS: two synthetic chats are
 * imported into one person and read as one feed (chronological, the conversation named where it
 * changes, a date jump across both, the calendar, a small DOM). Set E2E_SHOTS=<dir> to also save
 * screenshots. Every export is generated here: synthetic, never a real chat.
 */
const p = (x: number) => String(x).padStart(2, '0');
/** Chat A: 300 messages from 08:00 on 17 March 2026, 100 a day (Bo, Ana alternating). */
const chatA = Array.from({ length: 300 }, (_, k) => {
  const day = 17 + Math.floor(k / 100);
  const minute = k % 100;
  return `[${p(day)}/03/2026, ${p(8 + Math.floor(minute / 60))}:${p(minute % 60)}:00] ${(k + 1) % 2 ? 'Bo' : 'Ana'}: Chat A message ${k + 1}`;
});
/** Chat B: three messages in the evening of 18 March, between A's 200th and 201st. */
const chatB = ['Cy', 'Ana', 'Cy'].map((who, i) => `[18/03/2026, 20:0${i}:00] ${who}: Group message ${i + 1}`);
const zipOf = (name: string, lines: string[]) => ({ name, mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')) })) });

const feedOf = (page: Page) => page.getByRole('feed', { name: 'Messages of Mama, from all conversations' });
const article = (feed: Locator, position: number) => feed.locator(`article[aria-posinset="${position}"]`);
const rowCount = (feed: Locator) => feed.locator('[data-index]').count();

async function seedMama(page: Page) {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zipOf('WhatsApp Chat - Ana i Bo.zip', chatA), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await importFromPeople(page, zipOf('WhatsApp Chat - Familia.zip', chatB), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(/\/en\/person\/timeline\/\?id=[0-9a-f-]{36}$/);
}

test('a person has a Timeline: both chats in one feed, the conversation named where it changes', async ({ page }, testInfo) => {
  await seedMama(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
  await expect(page.locator('header')).toContainText('303 messages in 2 conversations · Mar 17, 2026 – Mar 19, 2026');
  await expect(page.getByRole('link', { name: 'Back to Mama' })).toBeVisible();

  // opens at the latest message, like a chat
  const feed = feedOf(page);
  await expect(article(feed, 303)).toBeInViewport();
  await expect(article(feed, 303)).toContainText('Chat A message 300');
  await expect(feed).toHaveAttribute('aria-busy', 'false');
  expect(await rowCount(feed)).toBeLessThan(80);
  expect(await overflowsHorizontally(page)).toBe(false);

  // the start: first message names its chat
  await feed.focus();
  await page.keyboard.press('Home');
  await expect(article(feed, 1)).toBeInViewport();
  await expect(article(feed, 1)).toContainText('Chat A message 1');
  await expect(article(feed, 1).getByRole('link', { name: /Ana i Bo/ })).toHaveAttribute('href', /\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-03-17$/);
  await expect(article(feed, 2).getByRole('link')).toHaveCount(0);

  // a date jump lands on the other chat's day, in order, and both chat changes are named
  await page.getByLabel('Go to date').fill('2026-03-18');
  await expect(article(feed, 101)).toBeInViewport();
  await expect(article(feed, 101)).toContainText('Wednesday, March 18, 2026');
  await page.getByLabel('Go to date').fill('2026-03-19');
  await expect(article(feed, 204)).toBeInViewport();
  await expect(article(feed, 204)).toContainText('Chat A message 201');
  await expect(article(feed, 204).getByRole('link', { name: /Ana i Bo/ })).toBeVisible();
  await expect(article(feed, 203)).toContainText('Group message 3');
  await expect(article(feed, 201)).toContainText('Group message 1');
  await expect(article(feed, 201).getByRole('link', { name: /Familia/ })).toHaveAttribute('href', /&date=2026-03-18$/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/person-timeline-${testInfo.project.name}.png` });

  // the label opens that conversation on that day
  await article(feed, 201).getByRole('link', { name: /Familia/ }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-03-18$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Familia' })).toBeVisible();
});

test('the Timeline calendar jumps across both chats, Back returns to the place, unknown people are calm', async ({ page }) => {
  await seedMama(page);
  const feed = feedOf(page);
  await expect(article(feed, 303)).toBeInViewport();
  const trigger = page.getByRole('button', { name: 'Calendar' });
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Calendar of this timeline' });
  await expect(panel.getByRole('heading', { name: 'Choose a month in 2026' })).toBeVisible();
  await panel.getByRole('button', { name: 'March, 303 messages' }).click();
  const grid = panel.getByRole('grid', { name: 'March 2026' });
  await grid.getByRole('button', { name: 'Wednesday, March 18, 2026, 103 messages' }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(article(feed, 101)).toBeInViewport();
  expect(await overflowsHorizontally(page)).toBe(false);

  // Back to the person and into the Timeline again: same place
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(article(feedOf(page), 101)).toBeInViewport();

  await page.goto('/en/person/timeline/?id=00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('heading', { level: 1, name: 'We could not find this person' })).toBeVisible();
});
