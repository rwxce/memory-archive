import { crc32, deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test, openSection } from './fixtures';

/**
 * A person's Gallery against the built app, with the real workers and OPFS: a small synthetic chat
 * with photos (real PNGs) and one video is imported, then the grid is checked (by month, oldest
 * first, videos read nothing, photos load only near the screen, 50 at a time) and a tile opens its
 * conversation on that day. Set E2E_SHOTS=<dir> to also save screenshots of the screen.
 */
/** A real, decodable RGB PNG; `noise` makes it large in bytes (a photo-sized file, above the thumbnail threshold). */
const pngOf = (width: number, height: number, noise: boolean) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw.set(noise ? [seed >> 8, seed >> 12, seed >> 16].map((v) => v & 255) : [x * 5, y * 5, 160], y * (width * 3 + 1) + 1 + x * 3);
    }
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
// 48x48: tiny, shown as it is. BIG: 640x480, well above the thumbnail threshold, so its tile shows a 320 px thumbnail.
const png = pngOf(48, 48, false);
const bigPng = pngOf(640, 480, true);

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
const files = [...Array.from({ length: MANY + 2 }, (_, i) => PHOTO(i))].map((name, i) => [name, new Uint8Array(i === 1 ? bigPng : png)] as const);
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
  await openSection(page, 'Gallery');
  await expect(page).toHaveURL(/\/en\/person\/gallery\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
  await expect(page.getByText('59 photos and videos')).toBeVisible();

  // oldest first, by month; 50 tiles of a fixed shape
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['January 2026', 'February 2026', 'March 2026']);
  const tiles = page.locator('section li button');
  await expect(tiles).toHaveCount(50);
  await expect(page.getByText('Showing 50 of 59')).toBeVisible();
  await expect(tiles.nth(0)).toHaveAccessibleName('View Photo, Jan 10, 2026, 9:05 AM, from “Ana i Bo”');
  await expect(tiles.nth(1)).toHaveAccessibleName('View Video, Jan 14, 2026, 12:00 PM, from “Ana i Bo”');
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

  // a big photo's tile shows a cached 320 px thumbnail (a 640x480 original), a small one shows itself
  const bigImg = tiles.nth(2).locator('img');
  await expect(bigImg).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => bigImg.evaluate((img: HTMLImageElement) => img.complete && [img.naturalWidth, img.naturalHeight].join('x'))).toBe('320x240');
  const thumbCount = () =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('memory-archive-thumbs');
      let n = 0;
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) if (/^[0-9a-f]{64}-320$/.test(name)) n++;
      return n;
    });
  await expect.poll(thumbCount).toBe(1);

  // scrolling brings them in
  await tiles.nth(49).scrollIntoViewIfNeeded();
  await expect(farImg).toHaveAttribute('src', /^blob:/);

  // after a reload the thumbnail comes from the cache: still 320 px, and nothing new is cached
  await page.reload();
  await expect(tiles.nth(2).locator('img')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => tiles.nth(2).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  expect(await thumbCount()).toBe(1);
  await expect(tiles.nth(0)).toBeVisible();

  // keyboard: tiles are buttons in DOM order
  await tiles.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(tiles.nth(1)).toBeFocused();

  // a tile opens the lightbox: a modal dialog, photo fitted, arrows walk, Escape returns focus
  await tiles.nth(0).scrollIntoViewIfNeeded();
  await tiles.nth(0).click();
  const box2 = page.getByRole('dialog');
  await expect(box2).toBeVisible();
  await expect(box2).toHaveAccessibleName('Photo from “Ana i Bo”, Jan 10, 2026, 9:05 AM');
  await expect(box2.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => box2.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(48);
  const big = await box2.locator('img').boundingBox();
  expect(big!.width).toBeLessThanOrEqual(48 + 1); // never enlarged past its own size
  await expect(box2.getByText(/^\d+ of \d+$/)).toHaveText('1 of 50');
  await expect(box2.getByRole('button', { name: 'Previous' })).toHaveAttribute('aria-disabled', 'true');
  for (const name of ['Close', 'Previous', 'Next']) {
    const b = await box2.getByRole('button', { name }).boundingBox();
    expect(b!.width).toBeGreaterThanOrEqual(44);
    expect(b!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await overflowsHorizontally(page)).toBe(false);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/person-gallery-lightbox-${testInfo.project.name}.png` });
  await page.keyboard.press('ArrowRight');
  await expect(box2.getByText(/^\d+ of \d+$/)).toHaveText('2 of 50');
  await expect(box2.locator('video')).toHaveAttribute('src', /^blob:/);
  await expect(box2.locator('img')).toHaveCount(0);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/person-gallery-lightbox-video-${testInfo.project.name}.png` });
  await box2.getByRole('button', { name: 'Previous' }).click();
  await expect(box2.getByText(/^\d+ of \d+$/)).toHaveText('1 of 50');
  await page.keyboard.press('Escape');
  await expect(box2).toBeHidden();
  await expect(tiles.nth(0)).toBeFocused();

  // Next at the last loaded item loads the next page
  await tiles.nth(49).scrollIntoViewIfNeeded();
  await tiles.nth(49).click();
  await expect(box2.getByText(/^\d+ of \d+$/)).toHaveText('50 of 50');
  await box2.getByRole('button', { name: 'Next' }).click();
  await expect(box2.getByText(/^\d+ of \d+$/)).toHaveText('51 of 59');
  await page.keyboard.press('Escape');
  await expect(tiles).toHaveCount(59);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // the lightbox links to the message's conversation on that day
  await tiles.nth(1).scrollIntoViewIfNeeded();
  await tiles.nth(1).click();
  await box2.getByRole('link', { name: 'Open in conversation' }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-01-14$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana i Bo' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();

  // an unknown person is calm, with the way back
  await page.goto('/en/person/gallery/?id=00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('heading', { level: 1, name: 'We could not find this person' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to People' }).first()).toBeVisible();
});
