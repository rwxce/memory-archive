import { crc32, deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, personMenu, startFresh, test } from './fixtures';

/**
 * Exporting one person from their page, against the built app with the real workers and OPFS:
 * pictures from the collection are assigned to a person, the person menu opens the export card with only
 * that person ticked, and the viewer copy carries their photos (opened from disk, like a user would).
 * Synthetic data only. Needs `pnpm build`. Screenshots go to .context/shots/.
 */

/** A real RGB PNG of one flat colour (distinct bytes per colour). */
const png = (r: number, g: number, b: number, size = 64) => {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([(r + x) & 255, (g + y) & 255, b], y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const loose = [0, 1, 2].map((i) => ({ name: `IMG_${i}.png`, mimeType: 'image/png', buffer: png(i * 70, 255 - i * 70, i * 30) }));
const chatZip = {
  name: 'WhatsApp Chat - Bo.zip',
  mimeType: 'application/zip',
  buffer: Buffer.from(zipSync({ '_chat.txt': strToU8([1, 2, 3].map((n) => `[1${n}/03/2026, 08:0${n}:00] ${n % 2 ? 'Bo' : 'Ana'}: Synthetic message ${n}`).join('\n')) })),
};

test('a person is exported from their page with the photos assigned to them, and the viewer shows them', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const shot = (name: string) => page.screenshot({ path: `.context/shots/${name}-${testInfo.project.name}.png` });
  await startFresh(page);
  await addPerson(page, 'Mama');
  await addPerson(page, 'Papa');
  await importFromPeople(page, chatZip, 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();

  // Three pictures into the collection; two chosen and given to Mama.
  await page.goto('/en/photos/');
  await page.getByTestId('photos-loose-input').setInputFiles(loose);
  await page.getByRole('button', { name: 'Add to the collection' }).click();
  await expect(page.getByTestId('photos-result')).toContainText('3 photos and videos added', { timeout: 60_000 });
  await page.getByRole('link', { name: 'Choose pictures' }).click();
  const options = page.locator('[role="listbox"] [role="option"]');
  await expect(options.first()).toBeVisible();
  await page.getByTestId('select-toggle').click();
  await options.nth(0).click();
  await options.nth(1).click();
  await page.getByRole('button', { name: 'Assign to…' }).click();
  const dialog = page.locator('dialog[aria-labelledby="assign-title"]');
  await dialog.getByRole('checkbox', { name: /Mama/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByTestId('select-result')).toContainText('2 assignments added.');

  // The person menu leads to the export card with only that person ticked.
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await personMenu(page, 'Mama', 'Export a copy');
  await expect(page).toHaveURL(/\/backup\/\?person=[^#]+#viewer-export$/);
  const card = page.getByTestId('viewer-export');
  await expect(card.getByRole('checkbox', { name: 'Mama' })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Papa' })).not.toBeChecked();
  await card.scrollIntoViewIfNeeded();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('export-person-card');

  const downloading = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Make the copy' }).click();
  const download = await downloading;
  const files = unzipSync(readFileSync((await download.path())!));
  expect(Object.keys(files)).toContain('viewer.html');
  expect(Object.keys(files).filter((name) => name.startsWith('media/'))).toHaveLength(2);

  // Opened from disk in its own context (the page fixture only allows the local server).
  const dir = mkdtempSync(join(tmpdir(), 'ma-export-'));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  try {
    const viewer = await context.newPage();
    await viewer.goto(`file://${join(dir, 'viewer.html')}`);
    await viewer.getByRole('button', { name: 'Photos (2)' }).click();
    const images = viewer.locator('.photo-grid img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll((list) => list.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await overflowsHorizontally(viewer)).toBe(false);
    await viewer.screenshot({ path: `.context/shots/export-person-viewer-${testInfo.project.name}.png` });
  } finally {
    await context.close();
  }
});
