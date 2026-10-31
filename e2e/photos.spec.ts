import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { expect, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * The Photos screen on the built app: a Takeout album and loose files from synthetic fixtures (invented bytes, never a
 * real picture), a second run that adds nothing, a file that belongs to another screen, and taking an import back.
 */
const takeoutZip = join(process.cwd(), 'fixtures', 'takeout-albums.zip');
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF-FAKE-${seed}-`.repeat(8))]);

test('photos can be added from a Takeout album and from the device, and an import can be taken back', async ({ page }) => {
  test.setTimeout(120_000);
  await startFresh(page);
  await page.goto('/en/settings/');
  await page.getByRole('link', { name: /^Photos/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
  await expect(page.getByText('Pictures added here are not assigned to anyone yet.')).toBeVisible();
  await expect(page.getByText('A date marked as an estimate comes from the file, not from the camera.')).toBeVisible();
  await expect(page.getByText('Nothing has been added yet.')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  // A Takeout album: told apart by its content.
  await page.getByTestId('photos-zip-input').setInputFiles(takeoutZip);
  const result = page.getByTestId('photos-result');
  await expect(result).toContainText('added to the collection', { timeout: 60_000 });
  const batches = page.getByTestId('photos-batches');
  await expect(batches).toContainText('takeout-albums.zip');
  await expect(batches).toContainText('Google Takeout');
  expect(await overflowsHorizontally(page)).toBe(false);

  // The same file again adds nothing.
  await page.getByTestId('photos-zip-input').setInputFiles(takeoutZip);
  await expect(page.getByTestId('photos-result')).toContainText('Nothing new was added', { timeout: 60_000 });
  await expect(page.getByTestId('photos-result')).toContainText('already in the collection');
  await expect(page.getByTestId('photos-batch')).toHaveCount(1);

  // Pictures from the device, under an album name; the choice can be dropped first.
  await page.getByTestId('photos-loose-input').setInputFiles([
    { name: 'IMG_1.jpg', mimeType: 'image/jpeg', buffer: jpeg('one') },
    { name: 'IMG_2.jpg', mimeType: 'image/jpeg', buffer: jpeg('two') },
  ]);
  await expect(page.getByTestId('photos-chosen')).toHaveText('2 files chosen');
  await page.getByRole('button', { name: 'Remove choice' }).click();
  await expect(page.getByTestId('photos-chosen')).toHaveCount(0);
  await page.getByTestId('photos-loose-input').setInputFiles([
    { name: 'IMG_1.jpg', mimeType: 'image/jpeg', buffer: jpeg('one') },
    { name: 'IMG_2.jpg', mimeType: 'image/jpeg', buffer: jpeg('two') },
  ]);
  await page.getByLabel('Album name (optional)').fill('Summer');
  await page.getByRole('button', { name: 'Add to the collection' }).click();
  await expect(page.getByTestId('photos-result')).toContainText('2 photos and videos added to the collection.', { timeout: 60_000 });
  await expect(page.getByTestId('photos-batches')).toContainText('Summer');
  await expect(page.getByTestId('photos-chosen')).toHaveCount(0);

  // A WhatsApp chat belongs to Import.
  const chat = zipSync({ '_chat.txt': strToU8('[17/03/2026, 13:17:05] Ana: Bon dia\n[17/03/2026, 13:17:30] Mama: Hola') });
  await page.getByTestId('photos-zip-input').setInputFiles({ name: 'chat.zip', mimeType: 'application/zip', buffer: Buffer.from(chat) });
  await expect(page.getByTestId('photos-result')).toContainText('is a WhatsApp chat');
  await expect(page.getByTestId('photos-result').getByRole('link', { name: 'Go to Import' })).toHaveAttribute('href', /\/en\/import\/?$/);
  await expect(page.getByTestId('photos-batch')).toHaveCount(2);

  // Taking the Takeout import back: asked first, naming it.
  await page.getByRole('button', { name: 'Undo import: takeout-albums.zip' }).click();
  await expect(page.getByText('Take back takeout-albums.zip?')).toBeVisible();
  await expect(page.getByText(/also used somewhere else/)).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByTestId('photos-batch')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo import: takeout-albums.zip' }).click();
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  await expect(page.getByTestId('photos-undo-result')).toContainText('removed from the collection');
  await expect(page.getByTestId('photos-batch')).toHaveCount(1);
});
