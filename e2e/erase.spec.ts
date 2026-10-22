import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/** Synthetic chat only (generated here): a few messages and one photo with some bulk so usage is measurable. */
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const CHAT = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: Hola',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
].join('\n');

function exportZip() {
  const photo = new Uint8Array(3_000_000).map((_, i) => (i * 7 + ((i >> 8) % 13)) % 251);
  return { name: 'WhatsApp Chat - Ana i Bo.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(CHAT), [PHOTO]: photo }, { level: 0 })) };
}

/** Bytes the app holds in OPFS (database, media, thumbnails). `storage.estimate()` also counts the service worker's precache and lags, so it is not used for assertions. */
const usedBytes = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const walk = async (dir: FileSystemDirectoryHandle): Promise<number> => {
      let total = 0;
      for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        total += handle.kind === 'file' ? (await (handle as FileSystemFileHandle).getFile()).size : await walk(handle as FileSystemDirectoryHandle);
      }
      return total;
    };
    return walk(await navigator.storage.getDirectory());
  });

test('erase everything: asks first, empties the library, goes back to the welcome', async ({ page }, info) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, exportZip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
  await page.goto('/en/settings/');
  await expect(page.getByTestId('storage-usage')).toContainText('used of about');
  const before = await usedBytes(page);
  expect(before).toBeGreaterThan(2_500_000);

  const shot = (name: string) => page.screenshot({ path: `.context/erase-${info.project.name}-${name}.png`, fullPage: false });
  await page.getByRole('button', { name: 'Erase everything from this device' }).scrollIntoViewIfNeeded();
  await shot('card');
  await page.getByRole('button', { name: 'Erase everything from this device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase everything from this device?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/backup ZIP first/)).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('dialog');

  // Cancel changes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await usedBytes(page)).toBeGreaterThan(2_500_000);

  await page.getByRole('button', { name: 'Erase everything from this device' }).click();
  await dialog.getByRole('button', { name: 'Erase everything' }).click();
  await expect(page).toHaveURL(/\/en\/welcome\/$/);
  await shot('welcome');
  // Nothing is left in OPFS (the welcome screen does not open the library).
  expect(await usedBytes(page)).toBe(0);

  await page.goto('/en/people/');
  await expect(page.getByRole('heading', { name: 'No one here yet' })).toBeVisible();
  await shot('people-empty');
  await page.goto('/en/settings/');
  // Opening People again made a new, empty library: a few hundred KB, no messages or photos.
  expect(await usedBytes(page)).toBeLessThan(1_000_000);
  await shot('settings-after');
});
