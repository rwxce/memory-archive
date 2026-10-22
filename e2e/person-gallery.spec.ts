import { crc32, deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

/**
 * A person's Gallery against the built app, with the real workers and OPFS: a small synthetic chat
 * with photos (real PNGs) and one video is imported, then the grid is checked (by month, oldest
 * first, videos read nothing, photos load only near the screen, 50 at a time) and a tile opens its
 * conversation on that day. Set E2E_SHOTS=<dir> to also save screenshots of the screen.
 */
const png = (() => {
  // A 48x48 RGB gradient: a real, decodable picture.
  const size = 48;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set([x * 5, y * 5, 160], y * (size * 3 + 1) + 1 + x * 3);
  }
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
})();

const PHOTO = (n: number) => `${String(n).padStart(8, '0')}-PHOTO-2026-03-13-10-00-00.png`;
const VIDEO = '00000099-VIDEO-2026-01-14-12-00-00.mp4';
const MANY = 56;
const lines = [
  `[10/01/2026, 09:05:00] Ana: <attached: ${PHOTO(0)}>`,
  `[14/01/2026, 12:00:00] Bo: <attached: ${VIDEO}>`,
  '[11/02/2026, 21:30:00] Bo: No pictures here',
  `[12/02/2026, 08:00:00] Ana: <attached: ${PHOTO(1)}>`,
  ...Array.from({ length: MANY }, (_, i) => `[13/03/2026, 10:${String(i).padStart(2, '0')}:00] Ana: <attached: ${PHOTO(i + 2)}>`),
];
const files = [...Array.from({ length: MANY + 2 }, (_, i) => PHOTO(i))].map((name) => [name, new Uint8Array(png)] as const);
const zip = () => ({
  name: 'WhatsApp Chat - Ana i Bo.zip',
  mimeType: 'application/zip',
  buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')), [VIDEO]: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), ...Object.fromEntries(files) })),
});

test('a person has a Gallery: by month, photos load near the screen, videos read nothing, tiles open the conversation', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();

  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/en\/person\/gallery\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
  await expect(page.getByText('59 photos and videos')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Gallery' })).toHaveAttribute('aria-current', 'page');

  // oldest first, by month; 50 tiles of a fixed shape
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['January 2026', 'February 2026', 'March 2026']);
  const tiles = page.locator('section li a');
  await expect(tiles).toHaveCount(50);
  await expect(page.getByText('Showing 50 of 59')).toBeVisible();
  await expect(tiles.nth(0)).toHaveAccessibleName('Open in conversation “Ana i Bo”: Photo, Jan 10, 2026, 9:05 AM');
  await expect(tiles.nth(1)).toHaveAccessibleName('Open in conversation “Ana i Bo”: Video, Jan 14, 2026, 12:00 PM');
  const box = await tiles.nth(0).boundingBox();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(await overflowsHorizontally(page)).toBe(false);

  // the first photo is read and shown; the video is not (a glyph and its name); far photos wait
  await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => tiles.nth(0).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(48);
  await expect(tiles.nth(1)).toContainText(VIDEO);
  await expect(tiles.nth(1).locator('img, video')).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  const farImg = tiles.nth(49).locator('img');
  expect(await page.locator('section li img').count()).toBeLessThan(49);
  await expect(farImg).toHaveCount(0);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/person-gallery-${testInfo.project.name}.png`, fullPage: true });

  // scrolling brings them in
  await tiles.nth(49).scrollIntoViewIfNeeded();
  await expect(farImg).toHaveAttribute('src', /^blob:/);

  // keyboard: tiles are links in DOM order
  await tiles.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(tiles.nth(1)).toBeFocused();

  // Show more
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(tiles).toHaveCount(59);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // the tile opens the message's conversation on that day
  await tiles.nth(1).scrollIntoViewIfNeeded();
  await tiles.nth(1).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-01-14$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana i Bo' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();

  // an unknown person is calm, with the way back
  await page.goto('/en/person/gallery/?id=00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('heading', { level: 1, name: 'We could not find this person' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to People' })).toBeVisible();
});
