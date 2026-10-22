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

export type ImportFile = string | { name: string; mimeType: string; buffer: Buffer };

/**
 * The import wizard from the file chooser to the confirmation, for a person who already exists
 * and an author called "Ana" who is the user. Waits for the preview of a large file.
 */
export async function walkImport(page: Page, file: ImportFile, person: string, confirm: string | RegExp): Promise<void> {
  const heading = (name: string | RegExp) => page.getByRole('heading', { level: 2, name });
  const next = () => page.getByRole('button', { name: 'Next' }).click();
  await page.getByTestId('import-file-input').setInputFiles(file);
  await page.getByRole('button', { name: 'Continue with 1 file' }).click();
  await expect(heading(/What is in this file/)).toBeFocused();
  await expect(page.getByText(/^[\d,]+ messages?$/)).toBeVisible({ timeout: 60_000 });
  await next();
  await expect(heading(/Who is this for/)).toBeFocused();
  await page.getByRole('radio', { name: new RegExp(`^${person}`) }).check();
  await next();
  await expect(heading(/Which one is you/)).toBeFocused();
  await page.getByRole('radio', { name: /^Ana/ }).check();
  await next();
  await expect(heading(/What is new/)).toBeFocused({ timeout: 30_000 });
  await next();
  await expect(heading(/Check and confirm/)).toBeFocused();
  await page.getByRole('button', { name: confirm }).click();
}

/** From People to the chooser, walk the wizard and wait for the result. */
export async function importFromPeople(page: Page, file: ImportFile, person: string, confirm: string | RegExp): Promise<void> {
  await page.getByRole('link', { name: /^Import( a chat)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import a chat' })).toBeVisible();
  await walkImport(page, file, person, confirm);
}

/** On a person's page: open one of its sections (Timeline, Gallery, Audio, Favorites, Notes) from the bento cards. */
export async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
}

/** On a sub-page of a person: back to their page with the back pill ("Back to Mama" is its name). */
export async function backToPerson(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: `Back to ${name}` }).click();
}

/** Opens a person's "..." menu (on their page) and chooses an item. */
export async function personMenu(page: Page, name: string, item: string | RegExp, menuLabel = `More options for ${name}`): Promise<void> {
  await page.getByRole('button', { name: menuLabel }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** In a conversation or timeline: opens "Go to date" (the calendar sheet) and types a day into its date field. */
export async function jumpToDate(page: Page, isoDay: string): Promise<void> {
  const input = page.locator('input[type="date"]');
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Go to date' }).click();
  await input.fill(isoDay);
}
