import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, overflowsHorizontally, startFresh, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The import wizard against the built app with the real workers and the real OPFS. The export is
 * generated here (a small two-person chat and one image): never a real chat, never read from disk.
 */
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const CHAT = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: Hola',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:10:00] Bo: Fins demà',
].join('\n');

function exportZip(name = 'WhatsApp Chat - Ana i Bo.zip') {
  const photo = new Uint8Array(512).map((_, i) => (i * 7 + 1) % 251);
  const buffer = Buffer.from(zipSync({ '_chat.txt': strToU8(CHAT), [PHOTO]: photo }));
  return { name, mimeType: 'application/zip', buffer };
}

const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 2, name });

/** People → Import a chat → the file → past the preview. */
async function chooseExport(page: Page) {
  await page.getByRole('link', { name: /^Import( a chat)?$/ }).click();
  await expect(page).toHaveURL(/\/en\/import\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Import a chat' })).toBeVisible();
  await page.getByTestId('import-file-input').setInputFiles(exportZip());
  await expect(page.getByText('WhatsApp Chat - Ana i Bo.zip')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with 1 file' }).click();
  await expect(heading(page, /What is in this file/)).toBeFocused();
  await expect(page.getByText('4 messages')).toBeVisible();
  await expect(page.getByText('1 photo')).toBeVisible();
}

const next = (page: Page) => page.getByRole('button', { name: 'Next' }).click();

/** Steps 2 to 5 for a person who already exists. */
async function importFor(page: Page, person: string, confirm: string) {
  await next(page);
  await expect(heading(page, /Who is this for/)).toBeFocused();
  await page.getByRole('radio', { name: new RegExp(`^${person}`) }).check();
  await next(page);
  await expect(heading(page, /Which one is you/)).toBeFocused();
  await page.getByRole('radio', { name: /^Ana/ }).check();
  await next(page);
  await expect(heading(page, /What is new/)).toBeFocused();
  await next(page);
  await expect(heading(page, /Check and confirm/)).toBeFocused();
  await page.getByRole('button', { name: confirm }).click();
}

test('imports a chat into a new person, shows the result and keeps working offline', async ({ page, context }) => {
  await startFresh(page);
  await chooseExport(page);
  expect(await overflowsHorizontally(page)).toBe(false);

  // Step 2: nothing is chosen for the person; add one on the spot.
  await next(page);
  await expect(heading(page, /Who is this for/)).toBeFocused();
  await next(page);
  await expect(page.getByText('Choose a person, or Decide later, to continue.')).toBeVisible();
  await page.getByRole('radio', { name: /^Add a new person/ }).check();
  await page.getByLabel('Name', { exact: true }).fill('Mama');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByRole('radio', { name: /^Mama/ })).toBeChecked();
  await expect(page.getByText('Mama was added.')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await next(page);

  // Step 3: two named authors, so no guess: the person chooses.
  await expect(heading(page, /Which one is you/)).toBeFocused();
  await expect(page.getByText('We guessed this one')).toHaveCount(0);
  await next(page);
  await expect(page.getByText('Choose one to continue.')).toBeVisible();
  await page.getByRole('radio', { name: /^Ana/ }).check();
  await next(page);

  // Step 4 and 5.
  await expect(page.getByText('This is a new conversation. All 4 messages will be added.')).toBeVisible();
  await next(page);
  await expect(heading(page, /Check and confirm/)).toBeFocused();
  await expect(page.getByRole('main').getByText('Mama', { exact: true })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.getByRole('button', { name: 'Add 4 messages to Mama' }).click();

  await expect(heading(page, 'Import finished')).toBeVisible();
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();
  await expect(page.getByText('1 photo or file saved.')).toBeVisible();
  await expect(page.getByText('New conversation: “Ana i Bo”.')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  // The person's page lists the conversation with the right count.
  await page.getByRole('link', { name: 'Open Mama' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
  const conversations = page.getByRole('list', { name: 'Conversations' });
  await expect(conversations.getByRole('heading', { name: 'Ana i Bo' })).toBeVisible();
  await expect(conversations.getByText(/4 messages/)).toBeVisible();

  // Offline: the stored conversation is still there after a reload.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Conversations' }).getByText(/4 messages/)).toBeVisible();
  await context.setOffline(false);
});

test('the same export again is "already in the archive" and adds nothing', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await chooseExport(page);
  await importFor(page, 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();

  // The same file again.
  await page.getByRole('button', { name: 'Import another chat' }).click();
  await page.getByTestId('import-file-input').setInputFiles(exportZip());
  await page.getByRole('button', { name: 'Continue with 1 file' }).click();
  await expect(page.getByText('4 messages')).toBeVisible();
  await next(page);
  await page.getByRole('radio', { name: /^Mama/ }).check();
  await next(page);
  await page.getByRole('radio', { name: /^Ana/ }).check();
  await next(page);
  await expect(heading(page, /What is new/)).toBeFocused();
  await expect(page.getByRole('heading', { name: 'This chat is already in the archive' })).toBeVisible();
  await expect(page.getByText('4 messages are already there and will not be copied again.')).toBeVisible();
  await expect(page.getByText('There are no new messages to add.')).toBeVisible();
  await next(page);
  await page.getByRole('button', { name: 'Finish without adding anything' }).click();
  await expect(page.getByText('No new messages were added to Mama.')).toBeVisible();
  await expect(page.getByText('4 messages were already in the archive and were not copied again.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Undo this import: / })).toHaveCount(0);

  // Still one conversation with 4 messages.
  await page.getByRole('link', { name: 'Open Mama' }).click();
  await expect(page.getByRole('list', { name: 'Conversations' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText(/4 messages/)).toBeVisible();
});

test('undo asks first, then removes the conversation the import created', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await chooseExport(page);
  await importFor(page, 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();

  await page.getByRole('button', { name: 'Undo this import: Ana i Bo' }).click();
  const panel = page.getByRole('group', { name: 'Undo this import?' });
  await expect(panel.getByText(/and so will the conversation “Ana i Bo”/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Keep it' })).toBeFocused();

  // Keeping it changes nothing.
  await panel.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();

  await page.getByRole('button', { name: 'Undo this import: Ana i Bo' }).click();
  await panel.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('The import was undone. 4 messages were removed.')).toBeVisible();

  await page.getByRole('link', { name: 'Go to People' }).click();
  await expect(page.getByRole('list', { name: 'People' }).getByText('No conversations yet')).toBeVisible();
});

test('a file that is neither ZIP nor text is left out with an explanation and nothing is read', async ({ page }) => {
  await startFresh(page);
  await page.getByRole('link', { name: /^Import( a chat)?$/ }).click();
  await page.getByTestId('import-file-input').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(CHAT) });
  await expect(page.getByText('1 file was left out: for now only WhatsApp ZIP, text and old backup files can be imported.')).toBeVisible();
  await expect(page.getByText('No files chosen yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue with/ })).toHaveAttribute('aria-disabled', 'true');
});

test('Catalan: the first steps are in Catalan', async ({ page }) => {
  await page.goto('/ca/import/');
  await expect(page.getByRole('heading', { level: 1, name: 'Importa una conversa' })).toBeVisible();
  await page.getByTestId('import-file-input').setInputFiles(exportZip());
  await page.getByRole('button', { name: 'Continua amb 1 fitxer' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /Què hi ha en aquest fitxer/ })).toBeFocused();
  await expect(page.getByText('4 missatges')).toBeVisible();
  await page.getByRole('button', { name: 'Següent' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /Per a qui és\?/ })).toBeFocused();
});
