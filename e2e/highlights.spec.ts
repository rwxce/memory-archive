import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * Highlights against the built app, with the real workers and OPFS: a synthetic findings file (the message
 * fingerprints below are pinned values of the three chat lines, from `fingerprintOf`; e2e does not import app code) is imported into the person's
 * conversation, the highlights are listed by category, filtered, opened and one is deleted after
 * asking. Set E2E_SHOTS=<dir> to save screenshots.
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
const highlight = (id: string, category: string, title: string, summary: string, messages: string[]) => ({ id, category, title, summary, messages, createdBy: 'synthetic', createdAt: '2026-03-01T10:00:00Z' });
const findings = {
  version: 1,
  conversation: { name: 'WhatsApp Chat - Ana i Bo', messageCount: 3, firstFingerprint: fps[0] },
  highlights: [
    highlight('greeting', 'moment', 'The first hello', 'How the conversation began.\nShort and warm.', [fps[0], fps[1]]),
    highlight('valentine', 'moment', 'A Valentine evening', 'Late message on 14 February.', [fps[2]]),
    highlight('replies', 'pattern', 'Bo always answers within a minute', 'Seen in the first exchange.', [fps[0], fps[1]]),
  ],
};
const file = (name: string, content: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(content)) });

test('import a findings file, list highlights by category, filter, open one, delete one after asking', async ({ page }, testInfo) => {
  const shot = async (name: string, fullPage = true) => {
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/highlights-${name}-${testInfo.project.name}.png`, fullPage });
  };
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Highlights/ }).click();
  await expect(page).toHaveURL(/\/en\/person\/highlights\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByText('There are no highlights for Mama yet.')).toBeVisible();
  await shot('empty');

  // a file that does not validate lists paths only and imports nothing
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(file('bad.json', { version: 1, conversation: { name: 'x', messageCount: 0 }, highlights: [{ id: 'a', category: 'nope' }] }));
  await expect(page.locator('main').getByRole('alert')).toContainText('highlights[0].category');
  await shot('invalid');
  await expect(page.getByText('There are no highlights for Mama yet.')).toBeVisible();

  await input.setInputFiles(file('findings.json', findings));
  await expect(page.getByText('3 highlights for “WhatsApp Chat - Ana i Bo”.')).toBeVisible();
  await shot('ready');
  await page.getByRole('button', { name: 'Import highlights' }).click();
  await expect(page.getByText('Import finished.')).toBeVisible();
  await expect(page.getByText('3 highlights added', { exact: true })).toBeVisible();
  await expect(page.getByText('3 highlights about Mama')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Moments (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Rituals (1)' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('list');

  // the same file again changes nothing
  await page.getByRole('button', { name: 'Import another file' }).click();
  await input.setInputFiles(file('findings.json', findings));
  await page.getByRole('button', { name: 'Import highlights' }).click();
  await expect(page.getByText('3 highlights were already there', { exact: true })).toBeVisible();
  await expect(page.getByText('3 highlights about Mama')).toBeVisible();

  // filter
  const chips = page.getByRole('group', { name: 'Show' });
  await chips.getByRole('button', { name: /^Rituals/ }).click();
  await expect(page.locator('main h3')).toHaveText(['Bo always answers within a minute']);
  await expect(chips.getByRole('button', { name: /^Rituals/ })).toHaveAttribute('aria-pressed', 'true');
  await chips.getByRole('button', { name: /^All/ }).click();
  await expect(page.locator('main h3')).toHaveCount(3);

  // delete one, asked first
  const card = page.locator('main li').filter({ hasText: 'A Valentine evening' });
  await card.getByRole('button', { name: 'Delete highlight “A Valentine evening”' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this highlight?' });
  await expect(dialog).toBeVisible();
  await shot('delete', false);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('main h3')).toHaveCount(3);
  await card.getByRole('button', { name: 'Delete highlight “A Valentine evening”' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('main h3')).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: 'Highlight deleted.' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Highlights' })).toBeFocused();

  // a reload keeps the deletion; importing the file brings it back
  await page.reload();
  await expect(page.locator('main h3')).toHaveCount(2);
  await input.setInputFiles(file('findings.json', findings));
  await page.getByRole('button', { name: 'Import highlights' }).click();
  await expect(page.getByText('1 highlight added', { exact: true })).toBeVisible();
  await expect(page.locator('main h3')).toHaveCount(3);

  // open one at the day of its first message
  await page.locator('main li').filter({ hasText: 'A Valentine evening' }).getByRole('link', { name: /^Open/ }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-02-14&back=highlights$/);
});
