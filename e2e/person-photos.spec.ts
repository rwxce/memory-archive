import { crc32, deflateSync } from 'node:zlib';
import { addPerson, expect, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * The pictures assigned to a person, on the built app with the real workers and OPFS: loose (tiny, real) PNGs are added to
 * the collection, three are assigned to Ana, and they show on her page: the Photos card, the grid, the picture opened,
 * "Take out" and the count after it. Set E2E_SHOTS=<dir> to also save screenshots.
 */

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
const loose = [0, 1, 2, 3].map((i) => ({ name: `IMG_${i}.png`, mimeType: 'image/png', buffer: png(i * 60, 255 - i * 60, i * 30) }));

test('pictures assigned to a person show on her page, open, and can be taken out', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const shot = (name: string) => (process.env.E2E_SHOTS ? page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: false }) : undefined);
  await startFresh(page);
  await addPerson(page, 'Ana', 'friend');

  // Four pictures in the collection; three of them go to Ana.
  await page.goto('/en/photos/');
  await page.getByTestId('photos-loose-input').setInputFiles(loose);
  await page.getByLabel('Album name (optional)').fill('Summer');
  await page.getByRole('button', { name: 'Add to the collection' }).click();
  await expect(page.getByTestId('photos-result')).toContainText('4 photos and videos added', { timeout: 60_000 });
  await page.getByRole('link', { name: 'Choose pictures' }).click();
  const options = page.locator('[role="listbox"] [role="option"]');
  await expect(options).toHaveCount(4);
  await page.getByTestId('select-toggle').click();
  for (const i of [0, 1, 2]) await options.nth(i).click();
  await page.getByRole('button', { name: 'Assign to…' }).click();
  const dialog = page.locator('dialog[aria-labelledby="assign-title"]');
  await dialog.getByRole('checkbox', { name: /Ana/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByTestId('select-result')).toContainText('3 assignments added.');

  // Her page has a Photos card with the count and previews.
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Ana' }).click();
  const card = page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /^Photos/ });
  await expect(card).toContainText('3 pictures assigned');
  await expect(card.locator('img')).toHaveCount(3, { timeout: 15_000 });
  await expect(card.locator('img').first()).toHaveAttribute('src', /^blob:/);
  expect(await overflowsHorizontally(page)).toBe(false);
  await card.scrollIntoViewIfNeeded();
  await shot('person-photos-card');

  // The grid lists exactly those three, under a day heading, and does not overflow.
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
  await expect(page.getByText('3 pictures assigned').first()).toBeVisible();
  const tiles = page.locator('section[data-day] li button[data-photo]');
  await expect(tiles).toHaveCount(3);
  await expect(page.locator('section[data-day] h2').first()).toBeVisible();
  await expect(tiles.first().locator('img')).toHaveAttribute('src', /^blob:/);
  for (const tile of await tiles.all()) expect((await tile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('person-photos-grid');

  // Open one: the detail view names Ana; Take out removes it from the list and the count follows.
  await tiles.first().click();
  const detail = page.getByRole('dialog', { name: 'Picture' });
  await expect(detail.getByTestId('detail-people')).toContainText('Ana');
  await expect(detail.getByText('1 of 3')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await shot('person-photos-detail');
  await detail.getByRole('button', { name: /Take this picture out of Ana/ }).click();
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText('2 pictures assigned').first()).toBeVisible();
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  // It is still so after a reload, and the card on her page agrees.
  await page.reload();
  await expect(tiles).toHaveCount(2);
  await page.getByRole('link', { name: 'Back to Ana' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /^Photos/ })).toContainText('2 pictures assigned');
});
