import { expect, test as base, type Page } from '@playwright/test';

/**
 * Shared fixtures. Every test runs in a fresh browser context (fresh OPFS).
 * `foreignRequests` records each request the context makes to an origin other
 * than the local preview server: it listens on the browser context, so pages,
 * dedicated workers and the service worker are all seen. The `page` fixture
 * fails the test when anything was recorded (no telemetry, CDN or remote
 * fonts: docs/privacy.md). It sees what Chrome requests through the context
 * only; it does not prove anything about traffic outside the browser.
 * data:, blob: and about: URLs never leave the machine and are ignored.
 */
export const test = base.extend<{ page: Page; foreignRequests: string[]; allowForeignRequests: boolean }>({
  // Set with test.use() in the guard's own self-test only.
  allowForeignRequests: [false, { option: true }],

  foreignRequests: async ({ context, baseURL }, use) => {
    const allowed = new URL(baseURL ?? 'http://localhost:4173').origin;
    const recorded: string[] = [];
    context.on('request', (request) => {
      const url = request.url();
      if (/^(data|blob|about):/.test(url)) return;
      if (new URL(url).origin !== allowed) recorded.push(url);
    });
    await use(recorded);
  },

  page: async ({ page, foreignRequests, allowForeignRequests }, use) => {
    await use(page);
    if (!allowForeignRequests) expect(foreignRequests, 'requests to non-local origins').toEqual([]);
  },
});

export { expect };

/**
 * True when the page is wider than the configured viewport. It compares with
 * the viewport size, not window.innerWidth: mobile emulation widens the layout
 * viewport to fit overflowing content, which would hide the overflow.
 */
export async function overflowsHorizontally(page: Page): Promise<boolean> {
  const width = page.viewportSize()?.width ?? 0;
  return page.evaluate((max) => document.documentElement.scrollWidth > max, width);
}

/** First run: welcome, Start, and the (empty) People screen. */
export async function startFresh(page: Page): Promise<void> {
  await page.goto('/en/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
}

/** Adds a person through the form and waits for the list to show them. */
export async function addPerson(page: Page, name: string, relationship = ''): Promise<void> {
  await page.getByRole('button', { name: 'Add a person' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (relationship) await page.getByLabel('Relationship (optional)').fill(relationship);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByRole('list', { name: 'People' }).getByRole('link', { name })).toBeVisible();
}
