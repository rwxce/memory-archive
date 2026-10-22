import { strToU8, zipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test, personMenu } from './fixtures';

/**
 * The search screen against the built app, with the real workers and OPFS: a synthetic chat is
 * imported, then searched from the People screen (an accent-less query finds an accented word, the
 * matches are marked, a result opens its conversation) and from the person page (scoped). The
 * "Preparing search" state is watched with an observer started before the page loads, because on a
 * small archive it is only on screen for a moment. Set E2E_SHOTS=<dir> to also save screenshots.
 * Every export is generated here: synthetic, never a real chat.
 */
const lines = [
  '[17/03/2026, 08:00:00] Bo: Bon dia, la cançó de l’estiu',
  '[17/03/2026, 08:01:00] Ana: Quina cançó?',
  '[17/03/2026, 08:02:00] Bo: <b>cançó</b> nova <img src=x onerror="window.__pwned=1">',
  '[18/03/2026, 09:00:00] Ana: Vam anar a la platja',
  ...Array.from({ length: 70 }, (_, k) => `[19/03/2026, 10:${String(k % 60).padStart(2, '0')}:00] Bo: lluna plena ${k + 1}`),
];
const zip = { name: 'WhatsApp Chat - Ana i Bo.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')) })) };

async function seedMama(page: Page) {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip, 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
}

test('search from People: accents ignored, matches marked, a result opens its conversation', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('progress')) (window as unknown as { __sawProgress?: boolean }).__sawProgress = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await seedMama(page);
  await page.goto('/en/search/');
  await expect(page).toHaveURL(/\/en\/search\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');

  const field = page.getByRole('main').getByRole('searchbox', { name: 'Search messages and file names' });
  await field.fill('c');
  await expect(page.getByText('Type at least 2 letters to search.')).toBeVisible();
  await field.fill('canco');
  const list = page.getByRole('list', { name: 'Search results' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(page).toHaveURL(/\?q=canco$/);
  expect(await page.evaluate(() => (window as unknown as { __sawProgress?: boolean }).__sawProgress)).toBe(true);
  await expect(page.locator('mark').first()).toHaveText('cançó');
  // hostile text stays text
  await expect(list.getByText('<b>cançó</b> nova', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(list.locator('img, b')).toHaveCount(0);
  expect(await overflowsHorizontally(page)).toBe(false);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/search-${testInfo.project.name}.png` });

  // paging: 70 matches of "lluna" come 50 at a time
  await field.fill('lluna');
  await expect(list.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(70);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // a result opens its conversation on that day
  await field.fill('platja');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const open = list.getByRole('link');
  await open.click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&date=2026-03-18$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana i Bo' })).toBeVisible();

  // Back returns to the search with the query
  await page.goBack();
  await expect(page.getByRole('main').getByRole('searchbox')).toHaveValue('platja');
});

test('search from a person and from a conversation is scoped, and can widen', async ({ page }, testInfo) => {
  await seedMama(page);
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await personMenu(page, 'Mama', /^Search in Mama/);
  await expect(page).toHaveURL(/\/en\/search\/\?person=[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Mama' })).toHaveAttribute('aria-pressed', 'true');
  const field = page.getByRole('main').getByRole('searchbox');
  await field.fill('platja');
  const list = page.getByRole('list', { name: 'Search results' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('link').first()).toHaveAttribute('href', /\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-03-18$/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/search-scoped-${testInfo.project.name}.png` });
  await page.getByRole('button', { name: 'Everyone' }).click();
  await expect(page.getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');

  // from the conversation header
  await list.getByRole('link').first().click();
  await page.getByRole('link', { name: 'Search in this conversation' }).click();
  await expect(page).toHaveURL(/\/en\/search\/\?conversation=[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Searching in “Ana i Bo”. Remove this filter' })).toBeVisible();
  await page.getByRole('main').getByRole('searchbox').fill('lluna plena 7');
  await expect(page.getByRole('list', { name: 'Search results' }).getByRole('listitem')).toHaveCount(1);

  // an address that matches nothing is calm
  await page.goto('/en/search/?person=00000000-0000-4000-8000-000000000001');
  await expect(page.getByRole('heading', { level: 1, name: 'We could not open this search' })).toBeVisible();
});
