import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { Locator, Page } from '@playwright/test';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test, jumpToDate } from './fixtures';

/**
 * The conversation view against the built app, with the real workers and OPFS: a small chat to check
 * what is on screen (starts at the last message, Home, jump to a date, an image, inert hostile text),
 * and a large one (30,000 messages, imported through the wizard) to check that scrolling stays smooth
 * and the DOM stays small. Every export is generated here: synthetic, never a real chat.
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PHOTO = '00000001-PHOTO-2026-03-17-08-03-00.jpg';
const NAME = 'WhatsApp Chat - Ana i Bo.zip';
const HOSTILE = '<img src=x onerror="window.__pwned=1"> see https://example.com/page?x=1 and javascript:void(0)';

/** `[17/03/2026, 08:00:00]` style stamps, `perDay` messages a day from 17 March 2026 (day first is unambiguous: 17 > 12). */
function lines(count: number, perDay: number, special: (i: number) => string | undefined = () => undefined): string[] {
  const start = Date.UTC(2026, 2, 17);
  const p = (x: number) => String(x).padStart(2, '0');
  return Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    const d = new Date(start + Math.floor(k / perDay) * 86_400_000 + (8 * 60 + (k % perDay)) * 60_000);
    const stamp = `[${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00]`;
    return `${stamp} ${special(i) ?? `${i % 2 ? 'Bo' : 'Ana'}: Message ${i}`}`;
  });
}

const feedOf = (page: Page) => page.getByRole('feed', { name: 'Messages in “Ana i Bo”' });
const article = (feed: Locator, position: number) => feed.locator(`article[aria-posinset="${position}"]`);
/** Rows in the DOM, real and placeholder. */
const rowCount = (feed: Locator) => feed.locator('[data-index]').count();

/** From the People list to one person's conversation. */
async function openConversation(page: Page) {
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await page.getByRole('link', { name: 'Open “Ana i Bo”' }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}$/);
}

test.describe('a small conversation', () => {
  const COUNT = 600;
  const zip = () => {
    const chat = lines(COUNT, 100, (i) =>
      i === 4 ? `Ana: <attached: ${PHOTO}>` : i === 11 ? 'Messages and calls are end-to-end encrypted.' : i === 21 ? `Bo: ${HOSTILE}` : undefined,
    );
    return { name: NAME, mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(chat.join('\n')), [PHOTO]: new Uint8Array(PNG) })) };
  };

  test('opens at the last message; Home shows the first and its image; a date jumps; the DOM stays small; hostile text is inert', async ({ page }) => {
    await startFresh(page);
    await addPerson(page, 'Mama');
    await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
    await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
    await openConversation(page);

    // header
    await expect(page.getByRole('heading', { level: 1, name: 'Ana i Bo' })).toBeVisible();
    await expect(page.locator('header')).toContainText(/600 messages · 2026/);
    await expect(page.locator('header')).toContainText('Kept under Mama');
    await expect(page.getByRole('link', { name: 'Back to Mama' })).toBeVisible();

    // starts at the last message, like a chat
    const feed = feedOf(page);
    await expect(feed).toBeVisible();
    await expect(article(feed, COUNT)).toBeInViewport();
    await expect(article(feed, COUNT)).toContainText('Message 600');
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    expect(await rowCount(feed)).toBeLessThan(80);
    expect(await overflowsHorizontally(page)).toBe(false);

    // Home, from the keyboard: the first message, its date separator and its image
    await feed.focus();
    await page.keyboard.press('Home');
    await expect(article(feed, 1)).toBeInViewport();
    await expect(article(feed, 1)).toContainText('Tuesday, March 17, 2026');
    await expect(article(feed, 1)).toContainText('Message 1');
    const image = article(feed, 4).locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(article(feed, 11)).toHaveAccessibleName(/^Notice, /);
    expect(await rowCount(feed)).toBeLessThan(80);

    // markup in a message is text; the link is a safe link
    const hostile = article(feed, 21);
    // The row is a few screens down on a short viewport: scroll until it is rendered.
    await expect
      .poll(async () => {
        if ((await hostile.count()) === 0) await feed.evaluate((el) => el.scrollBy(0, el.clientHeight / 2));
        return hostile.count();
      })
      .toBe(1);
    await expect(hostile).toContainText('<img src=x onerror="window.__pwned=1">');
    await expect(hostile.locator('img')).toHaveCount(0);
    await expect(hostile.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(hostile.getByRole('link')).toHaveAttribute('href', 'https://example.com/page?x=1');
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();

    // jump to a date: the first message of that day, with its separator
    await jumpToDate(page, '2026-03-20');
    await expect(article(feed, 301)).toBeInViewport();
    await expect(article(feed, 301)).toContainText('Friday, March 20, 2026');
    await expect(page.getByRole('status').filter({ hasText: 'Showing the first message on or after Mar 20, 2026.' })).toBeVisible();
    expect(await rowCount(feed)).toBeLessThan(80);

    // and back to the end
    await page.getByRole('button', { name: 'Latest' }).click();
    await expect(article(feed, COUNT)).toBeInViewport();

    // an unknown conversation is calm, with the way back
    await page.goto('/en/conversation/?id=00000000-0000-4000-8000-000000000099');
    await expect(page.getByRole('heading', { level: 1, name: 'We could not find this conversation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'People', exact: true })).toBeVisible();
  });

  test('the calendar jumps to a day with messages from the keyboard, and Escape closes it', async ({ page }) => {
    await startFresh(page);
    await addPerson(page, 'Mama');
    await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
    await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
    await openConversation(page);
    const feed = feedOf(page);
    await expect(article(feed, COUNT)).toBeInViewport();

    const trigger = page.getByRole('button', { name: 'Go to date' });
    await trigger.click();
    const panel = page.getByRole('region', { name: 'Calendar of this conversation' });
    // one year only, so it opens on its months; only March has messages
    await expect(panel.getByRole('heading', { name: 'Choose a month in 2026' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'April, no messages' })).toBeDisabled();
    expect(await overflowsHorizontally(page)).toBe(false);
    await panel.getByRole('button', { name: 'March, 600 messages' }).click();

    // the grid: empty days are not actions; arrows move, Enter chooses
    const grid = panel.getByRole('grid', { name: 'March 2026' });
    await expect(grid.getByRole('button', { name: 'Monday, March 16, 2026, no messages' })).toHaveAttribute('aria-disabled', 'true');
    const first = grid.getByRole('button', { name: 'Tuesday, March 17, 2026, 100 messages' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('button', { name: /^Thursday, March 19, 2026/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(article(feed, 301)).toBeInViewport();
    await expect(article(feed, 301)).toContainText('Friday, March 20, 2026');
    await expect(page.getByRole('status').filter({ hasText: 'Showing the first message on or after Mar 20, 2026.' })).toBeVisible();

    // Escape closes it and gives focus back
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('heading', { name: 'Choose a month in 2026' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Back returns to where the person was reading', async ({ page }) => {
    await startFresh(page);
    await addPerson(page, 'Mama');
    await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
    await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
    await openConversation(page);
    const feed = feedOf(page);
    await jumpToDate(page, '2026-03-19');
    await expect(article(feed, 201)).toBeInViewport();
    await page.getByRole('link', { name: 'Back to Mama' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
    await page.getByRole('link', { name: 'Open “Ana i Bo”' }).click();
    await expect(article(feedOf(page), 201)).toBeInViewport();
  });

  test('message details open under the message, from the keyboard, without the feed jumping', async ({ page }, testInfo) => {
    await startFresh(page);
    await addPerson(page, 'Mama');
    await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
    await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();
    await openConversation(page);
    const feed = feedOf(page);
    await jumpToDate(page, '2026-03-20');
    await expect(article(feed, 301)).toBeInViewport();
    await expect(feed).toHaveAttribute('aria-busy', 'false');

    const message = article(feed, 302);
    const top = async (position: number) => (await article(feed, position).boundingBox())!.y;
    const topBefore = await top(301);
    const belowBefore = await top(303);
    const scrollBefore = await feed.evaluate((el) => el.scrollTop);

    // keyboard: focus the button, Enter opens, Space closes, Enter opens again
    const toggle = message.getByRole('button', { name: 'Message details' });
    await toggle.focus();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const box = (await toggle.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = message.locator(`#${await toggle.getAttribute('aria-controls')}`);
    await expect(details).toContainText(`Source: WhatsApp (${NAME})`);
    await expect(details).toContainText(/Imported .*\d{4}/);
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(details).toContainText('Source: WhatsApp');

    // the rows above stay where they were, the row below makes room, and the feed did not scroll
    expect(Math.abs((await top(301)) - topBefore)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await top(303)) - belowBefore).toBeGreaterThan(0);
    expect(await feed.evaluate((el) => el.scrollTop)).toBe(scrollBefore);
    expect(await rowCount(feed)).toBeLessThan(80);
    expect(await overflowsHorizontally(page)).toBe(false);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/message-details-${testInfo.project.name}.png` });
  });
});

test.describe('a large conversation', () => {
  const COUNT = 30_000;
  let dir: string;
  let file: string;

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-archive-e2e-'));
    file = join(dir, NAME);
    // 30,000 lines (about 1.5 MB), 200 a day: written once per worker, outside the app.
    writeFileSync(file, zipSync({ '_chat.txt': strToU8(lines(COUNT, 200).join('\n')) }));
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('scrolls without long frames and keeps the DOM small', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await startFresh(page);
    await addPerson(page, 'Mama');
    const imported = Date.now();
    await importFromPeople(page, file, 'Mama', /^Add [\d,]+ messages to Mama$/);
    await expect(page.getByText(/new messages added to Mama\./)).toBeVisible({ timeout: 180_000 });
    const importSeconds = (Date.now() - imported) / 1000;
    await openConversation(page);

    const feed = feedOf(page);
    await expect(article(feed, COUNT)).toBeInViewport();
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    expect(await rowCount(feed)).toBeLessThan(80);

    // Frame times while the list is scrolled programmatically at a fast fling, down and then up,
    // at full speed and with the CPU slowed 4x (a rough stand-in for a mid-range phone).
    const cdp = await page.context().newCDPSession(page);
    const measureFrames = () =>
      feed.evaluate(async (el) => {
        const deltas: number[] = [];
        const seen = new Set<string>(); // sampled every 10th frame: proof that different messages really came and went
        const run = (step: number, count: number) =>
          new Promise<void>((resolve) => {
            let last = performance.now();
            let n = 0;
            const tick = (now: number) => {
              deltas.push(now - last);
              last = now;
              if (n % 10 === 0) for (const row of el.querySelectorAll('article')) seen.add(row.getAttribute('aria-posinset')!);
              el.scrollTop += step;
              if (++n < count) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
        el.scrollTop = el.scrollHeight / 2;
        await run(900, 240);
        await run(-900, 240);
        return { deltas: deltas.slice(3), distinctMessages: seen.size, scrolledTo: el.scrollTop };
      });
    const describeFrames = (frames: number[]) => {
      const sorted = [...frames].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1)!, text: `frames=${frames.length} p50=${at(0.5).toFixed(1)}ms p95=${at(0.95).toFixed(1)}ms p99=${at(0.99).toFixed(1)}ms max=${sorted.at(-1)!.toFixed(1)}ms` };
    };
    const record = (label: string, text: string) => {
      testInfo.annotations.push({ type: `perf: ${label}`, description: `${text} (${testInfo.project.name}, ${COUNT} messages)` });
      console.log(`[perf] ${label}: ${text} (${testInfo.project.name}, ${COUNT} messages)`);
    };
    const fullRun = await measureFrames();
    // 480 frames x 900 px are 430,000 px; the rows seen must have changed all along, not stood still.
    expect(fullRun.distinctMessages).toBeGreaterThan(1000);
    const full = describeFrames(fullRun.deltas);
    record('scroll frames', `${full.text} distinctMessagesSeen=${fullRun.distinctMessages} import=${importSeconds.toFixed(1)}s`);
    // Generous on purpose (a 60 Hz frame is 16.7 ms): this catches a list that renders thousands of rows or
    // blocks on every page, not machine-to-machine noise. The numbers above are the record.
    expect(full.p95, full.text).toBeLessThan(50);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const slowRun = await measureFrames();
    expect(slowRun.distinctMessages).toBeGreaterThan(1000);
    const slow = describeFrames(slowRun.deltas);
    record('scroll frames, CPU 4x slower', slow.text);
    // Scales with the machine: a loaded CI runner doubles the unthrottled frames too, so the budget follows them
    // (the throttled run is about 8x the unthrottled p95 on a quiet machine, never below 120 ms).
    expect(slow.p95, slow.text).toBeLessThan(Math.max(120, full.p95 * 8));
    expect(await rowCount(feed)).toBeLessThan(80);

    // How long a far jump takes until the rows in view are real messages (page read, render, measure).
    const jumps = await feed.evaluate(async (el) => {
      const results: number[] = [];
      for (const fraction of [0.02, 0.5, 0.97, 0.25, 0.75]) {
        const started = performance.now();
        el.scrollTop = el.scrollHeight * fraction;
        await new Promise<void>((resolve) => {
          const check = () => {
            const view = el.getBoundingClientRect();
            const inView = [...el.querySelectorAll('[data-index]')].filter((row) => {
              const r = row.getBoundingClientRect();
              return r.bottom > view.top && r.top < view.bottom;
            });
            if (inView.length > 0 && inView.every((row) => row.tagName === 'ARTICLE')) resolve();
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        results.push(performance.now() - started);
      }
      return results;
    });
    record('far jump until messages are shown (CPU 4x slower)', jumps.map((ms) => `${ms.toFixed(0)}ms`).join(', '));
    expect(Math.max(...jumps)).toBeLessThan(3000);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    // The ends are still right after all that.
    await feed.focus();
    await page.keyboard.press('Home');
    await expect(article(feed, 1)).toBeInViewport();
    await page.keyboard.press('End');
    await expect(article(feed, COUNT)).toBeInViewport();
    expect(await rowCount(feed)).toBeLessThan(80);
  });
});
