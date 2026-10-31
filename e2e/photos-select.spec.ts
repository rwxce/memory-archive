import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { addPerson, expect, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * Choosing pictures for people on the built app, with the real workers and OPFS: a Takeout album and some real (tiny)
 * PNGs from the device are added, a person is created, pictures are chosen, assigned, kept after a reload, and taken out
 * again. Set E2E_SHOTS=<dir> to also save screenshots.
 */
const takeoutZip = join(process.cwd(), 'fixtures', 'takeout-albums.zip');

/** A real RGB PNG of one flat colour (distinct bytes per colour). */
const png = (r: number, g: number, b: number, size = 96) => {
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
const loose = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `IMG_${i}.png`, mimeType: 'image/png', buffer: png(i * 40, 255 - i * 40, i * 20) }));

test('pictures are chosen, assigned to a person, kept after a reload and taken out again', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const shot = (name: string) => (process.env.E2E_SHOTS ? page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: false }) : undefined);
  await startFresh(page);
  await addPerson(page, 'Ana', 'friend');

  await page.goto('/en/photos/');
  await page.getByTestId('photos-zip-input').setInputFiles(takeoutZip);
  await expect(page.getByTestId('photos-result')).toContainText('added to the collection', { timeout: 60_000 });
  await page.getByTestId('photos-loose-input').setInputFiles(loose);
  await page.getByLabel('Album name (optional)').fill('Summer');
  await page.getByRole('button', { name: 'Add to the collection' }).click();
  await expect(page.getByTestId('photos-result')).toContainText('6 photos and videos added', { timeout: 60_000 });
  await expect(page.getByTestId('photos-unassigned')).toContainText('pictures are not assigned to anyone yet');

  // The way in from Photos.
  await page.getByRole('link', { name: 'Choose pictures' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Choose pictures for people' })).toBeVisible();
  const options = page.locator('[role="listbox"] [role="option"]');
  await expect(options.first()).toBeVisible();
  const total = await options.count();
  expect(total).toBeGreaterThanOrEqual(10);
  expect(await overflowsHorizontally(page)).toBe(false);
  // Days have headings; the loose files' dates are estimates and say so.
  await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  await expect(page.getByText('Estimated').first()).toBeVisible();
  await expect(page.locator('[data-photo] img').first()).toHaveAttribute('src', /^blob:/);
  await shot('photos-select');

  // Choose two pictures with Select; the bar counts them.
  await page.getByTestId('select-toggle').click();
  await options.nth(0).click();
  await options.nth(1).click();
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('select-bar')).toContainText('2 pictures selected');
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('photos-select-chosen');

  // Assign them to Ana: the question names the pictures and the person, and says nothing goes by date.
  await page.getByRole('button', { name: 'Assign to…' }).click();
  const dialog = page.locator('dialog[aria-labelledby="assign-title"]');
  await dialog.getByRole('checkbox', { name: /Ana/ }).check();
  await shot('photos-select-picker');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toContainText('2 pictures will be assigned to:');
  await expect(dialog).toContainText('Nothing is assigned by date; only these pictures.');
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('photos-select-confirm');
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByTestId('select-result')).toContainText('2 assignments added.');
  await expect(page.getByTestId('select-result')).toBeFocused();
  await expect(options).toHaveCount(total - 2);
  await shot('photos-select-done');

  // It is still so after a reload; the Assigned list has exactly those two.
  await page.reload();
  await expect(options.first()).toBeVisible();
  await expect(options).toHaveCount(total - 2);
  await page.getByRole('button', { name: /^Assigned/ }).click();
  await expect(options).toHaveCount(2);

  // Take one out from the picture's own view: it leaves the Assigned list, and the focus comes back to the grid.
  await options.first().click();
  const detail = page.getByRole('dialog', { name: 'Picture' });
  await expect(detail.getByTestId('detail-people')).toContainText('Ana');
  await expect(detail.getByTestId('detail-date')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('photos-select-detail');
  await detail.getByRole('button', { name: /Take this picture out of Ana/ }).click();
  await expect(options).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await page.getByRole('button', { name: /^Not assigned/ }).click();
  await expect(options).toHaveCount(total - 1);

  // The Undo import warning mentions people.
  await page.goto('/en/photos/');
  await expect(page.getByTestId('photos-unassigned')).toContainText(`${total - 1} pictures`);
  await page.getByRole('button', { name: 'Undo import: takeout-albums.zip' }).click();
  await expect(page.getByText(/taken out of those people too/)).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
});
