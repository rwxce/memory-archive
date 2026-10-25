import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * Highlight quick links and "Delete all", against the built app with the real workers and OPFS. A
 * synthetic findings file is imported, a highlight's messages are opened as links to the exact message
 * (scrolled to, marked, focused, announced), then all highlights are deleted after asking. The
 * fingerprints are pinned values of the three chat lines (as in highlights.spec.ts). Set
 * E2E_SHOTS=<dir> to save screenshots.
 */
const chat = [
  '[13/01/2026, 09:05:00] Ana: First hello',
  '[13/01/2026, 09:06:00] Bo: Second hello',
  '[14/02/2026, 21:30:00] Bo: Third hello',
].join('\n');
const zip = () => ({ name: 'WhatsApp Chat - Ana i Bo.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(chat) })) });
const fps = [
  '665673bcde6c96fbebf256518fdc53496511980512066450cfd297658a14d47a',
  '2011a632e7dadf8f10f4c2c154adbb2f3f5c17d1fb971bce4080abaef2bd1e21',
  'fa648d505223e52bd0bfdf7568ce72f37e4282b8d646d98a98d930f5195d37d4',
];
const highlight = (id: string, category: string, title: string, messages: string[]) => ({ id, category, title, summary: 'Synthetic.', messages, createdBy: 'synthetic', createdAt: '2026-03-01T10:00:00Z' });
const findings = {
  version: 1,
  conversation: { name: 'WhatsApp Chat - Ana i Bo', messageCount: 3, firstFingerprint: fps[0] },
  highlights: [
    highlight('greeting', 'moment', 'The first hello', [fps[0], fps[1]]),
    highlight('valentine', 'moment', 'A Valentine evening', [fps[2]]),
  ],
};

test('quick links open the exact message; Delete all asks first and clears the list', async ({ page }, testInfo) => {
  if (testInfo.project.name.startsWith('mobile')) await page.setViewportSize({ width: 375, height: 812 });
  const shot = async (name: string, fullPage = false) => {
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage });
  };
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Highlights/ }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'findings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(findings)) });
  await page.getByRole('button', { name: 'Import highlights' }).click();
  await expect(page.getByText('2 highlights about Mama')).toBeVisible();

  // the messages load when opened, as links to each exact message
  const card = page.locator('main li').filter({ hasText: 'The first hello' });
  await expect(card.getByRole('list')).toHaveCount(0);
  await card.getByRole('button', { name: 'Show messages (2)' }).click();
  const links = card.getByRole('list').getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(1)).toContainText('Second hello');
  await expect(links.nth(1)).toHaveAttribute('href', /\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-01-13&message=\d+&back=highlights$/);
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('quicklinks-list');

  await links.nth(1).click();
  await expect(page).toHaveURL(/&date=2026-01-13&message=\d+&back=highlights$/);
  const row = page.locator('[role="feed"] article', { hasText: 'Second hello' });
  await expect(row).toBeFocused();
  await expect(row).toHaveClass(/jump-flash/);
  const tint = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.waitForTimeout(250);
  const mid = await tint(); // mid-fade: neither the full accent tint nor transparent
  await shot('flash-mid');
  await expect(page.getByRole('status').filter({ hasText: /^Message from / })).toBeVisible();
  await shot('quicklinks-conversation');
  expect(mid).not.toBe('rgba(0, 0, 0, 0)');
  await expect(row).not.toHaveClass(/jump-flash/, { timeout: 4000 });
  await expect(row).toBeFocused();

  // the back pill returns to the Highlights list it came from
  await page.getByRole('link', { name: "Back to Mama's highlights" }).click();
  await expect(page).toHaveURL(/\/en\/person\/highlights\/\?id=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Highlights' })).toBeVisible();
  await page.goBack();

  // a link with an invalid message id still opens at the day
  await page.goto(page.url().replace(/message=\d+/, 'message=nope'));
  await expect(page.locator('[role="feed"] article', { hasText: 'Second hello' })).toBeVisible();
  await expect(page.locator('[role="feed"] .jump-flash')).toHaveCount(0);

  // Delete all, asked first
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Highlights/ }).click();
  await expect(page.locator('main h3')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete all' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete all highlights of Mama?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('import the findings file again');
  await shot('delete-all-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('main h3')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete all' }).click();
  await dialog.getByRole('button', { name: 'Delete all' }).click();
  await expect(page.locator('main h3')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '2 highlights deleted.' })).toBeVisible();
  await expect(page.getByText('There are no highlights for Mama yet.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Highlights' })).toBeFocused();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('delete-all-done');
  await page.reload();
  await expect(page.getByText('There are no highlights for Mama yet.')).toBeVisible();
});
