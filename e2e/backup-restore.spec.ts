import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import type { Browser, Download, Page, TestInfo } from '@playwright/test';
import { addPerson, expect, importFromPeople, openSection, startFresh, test, walkImport } from './fixtures';

/**
 * The PRD acceptance scenario (section 14) for backup and restore, against the built app with the real workers
 * and the real OPFS, in Chromium: ten people, imports (a newer export for Mama adds only the difference),
 * photos so media blobs exist, a note and a favorite; then a full backup (plain and password-protected) is
 * opened in FRESH browser contexts (a new context is a clean OPFS) and everything must be back, identical to what
 * was captured before; "Check my archive" must be all good; and "Replace my archive" on a non-empty library must
 * download a safety copy first and end identical too. Every export is generated here (synthetic names, never a real
 * chat, nothing read from disk). Safari and Firefox stay a manual item (docs/roadmap.md, Phase 6).
 */
const PASSWORD = 'correct horse battery staple';
const PEOPLE = ['Mama', 'Papa', 'Tia Rosa', 'Avi', 'Oncle Joan', 'Germana', 'Cosina', 'Amic Pere', 'Veina', 'Mestra'];

/** A tiny real RGB PNG; `shade` makes each photo distinct so every one is its own blob. */
function png(shade: number): Uint8Array {
  const size = 24;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set([(x * 9 + shade) & 255, (y * 9 + shade * 3) & 255, shade & 255], y * (size * 3 + 1) + 1 + x * 3);
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
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const photoName = (n: number) => `${String(n).padStart(8, '0')}-PHOTO-2026-03-17-13-20-00.png`;

/** A chat between "Ana" (the user) and `other`, with optional photo and extra lines. */
function chatZip(other: string, shade: number | undefined, extra: string[] = []) {
  const lines = [`[17/03/2026, 13:17:05] Ana: Bon dia ${other}`, `[17/03/2026, 13:17:30] ${other}: Hola Ana`, `[18/03/2026, 09:10:00] ${other}: Fins demà`];
  const files: Record<string, Uint8Array> = {};
  if (shade !== undefined) {
    lines.splice(2, 0, `[17/03/2026, 13:20:00] Ana: <attached: ${photoName(shade)}>`);
    files[photoName(shade)] = png(shade);
  }
  lines.push(...extra);
  return { name: `WhatsApp Chat - Ana i ${other}.zip`, mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...files })) };
}

const article = (page: Page, position: number) => page.locator(`[role="feed"] article[aria-posinset="${position}"]`);

async function openPerson(page: Page, name: string) {
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

async function buildLibrary(page: Page) {
  await startFresh(page);
  for (const name of PEOPLE) await addPerson(page, name);

  await importFromPeople(page, chatZip('Mama', 1), 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();
  // A newer export for Mama: the first four messages are already there, only two are new.
  await page.getByRole('button', { name: 'Import another chat' }).click();
  const newer = chatZip('Mama', 1, ['[19/03/2026, 10:00:00] Ana: Una nova', '[19/03/2026, 10:05:00] Mama: Dues noves']);
  await walkImport(page, newer, 'Mama', 'Add 2 messages to Mama');
  await expect(page.getByText('2 new messages added to Mama.')).toBeVisible();
  await expect(page.getByText('4 messages were already in the archive and were not copied again.')).toBeVisible();

  await page.getByRole('button', { name: 'Import another chat' }).click();
  await walkImport(page, chatZip('Papa', 2), 'Papa', 'Add 4 messages to Papa');
  await expect(page.getByText('4 new messages added to Papa.')).toBeVisible();
  await page.getByRole('button', { name: 'Import another chat' }).click();
  await walkImport(page, chatZip('Rosa', undefined), 'Tia Rosa', 'Add 3 messages to Tia Rosa');
  await expect(page.getByText('3 new messages added to Tia Rosa.')).toBeVisible();
  await page.getByRole('button', { name: 'Import another chat' }).click();
  await walkImport(page, chatZip('Avi', 3), 'Avi', 'Add 4 messages to Avi');
  await expect(page.getByText('4 new messages added to Avi.')).toBeVisible();

  // A note on Mama's second message, a note about Mama, and a favorite on one of Papa's messages.
  await openPerson(page, 'Mama');
  await page.getByRole('link', { name: /Ana i Mama/ }).first().click();
  await expect(article(page, 6)).toBeVisible();
  await article(page, 2).getByRole('button', { name: 'Add a note' }).click();
  const field = article(page, 2).getByLabel('Note about this message');
  await field.fill('Ella ho cantava cada dia.');
  await field.press('ControlOrMeta+Enter');
  await expect(article(page, 2).getByText(/^Saved /)).toBeVisible();
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await page.getByRole('button', { name: 'More options for Mama' }).click();
  await page.getByRole('menuitem', { name: 'Note about this person' }).click();
  await page.getByLabel('Note about this person').fill('La meva mare.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText(/^Saved /)).toBeVisible();

  await openPerson(page, 'Papa');
  await page.getByRole('link', { name: /Ana i Papa/ }).first().click();
  const star = article(page, 3).getByRole('button', { name: /favorites$/ });
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
}

/** Everything the screens say about the library: counts, media bytes, each person and the sections of those with data. */
async function snapshot(page: Page): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  await page.goto('/en/backup/');
  await expect(page.getByTestId('backup-counts')).toContainText('people');
  await expect(page.getByTestId('backup-counts')).not.toContainText('Counting');
  state.counts = await page.getByTestId('backup-counts').innerText();
  const bytes = await page.getByTestId('backup-bytes').innerText();
  state.mediaBytes = bytes.split('\n').find((line) => line.includes('Photos, videos and audio')) ?? bytes.split('\n')[0]!;
  const bytesLines = bytes.split('\n').join('|');
  state.bytes = bytesLines;

  await page.goto('/en/people/');
  const list = page.getByRole('list', { name: 'People' });
  await expect(list.getByRole('listitem')).toHaveCount(PEOPLE.length);
  state.people = await list.innerText();

  for (const name of ['Mama', 'Papa', 'Tia Rosa', 'Avi']) {
    await openPerson(page, name);
    const conversations = page.getByRole('list', { name: 'Conversations' });
    await expect(conversations.getByRole('listitem')).toHaveCount(1);
    state[`${name}/conversations`] = await conversations.innerText();
    await openSection(page, 'Favorites');
    await expect(page.getByRole('heading', { level: 1, name: 'Favorites' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Loading');
    state[`${name}/favorites`] = await page.locator('main').innerText();
    await page.getByRole('link', { name: `Back to ${name}` }).click();
    await openSection(page, 'Notes');
    await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Loading');
    state[`${name}/notes`] = await page.locator('main').innerText();
  }
  return state;
}

/** A fresh browser context (clean OPFS) with the project's viewport, watched for requests to other origins. */
async function freshContext(browser: Browser, testInfo: TestInfo, foreign: string[]) {
  const use = testInfo.project.use;
  const baseURL = testInfo.project.use.baseURL!;
  const context = await browser.newContext({
    baseURL,
    locale: 'en-US',
    viewport: use.viewport,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    deviceScaleFactor: use.deviceScaleFactor,
    acceptDownloads: true,
  });
  context.on('request', (request) => {
    const url = request.url();
    if (!/^(data|blob|about):/.test(url) && new URL(url).origin !== new URL(baseURL).origin) foreign.push(url);
  });
  return { context, page: await context.newPage() };
}

async function makeBackup(page: Page, dir: string, password?: string): Promise<{ path: string; name: string }> {
  await page.goto('/en/backup/');
  await expect(page.getByTestId('backup-counts')).not.toContainText('Counting');
  if (password) {
    await page.getByLabel('Protect with a password').check();
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Repeat the password').fill(password);
  }
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up the whole archive' }).click();
  const download = await downloading;
  await expect(page.getByText(password ? 'The backup was saved as a protected file.' : 'The backup was saved as a ZIP file.')).toBeVisible({ timeout: 60_000 });
  const path = join(dir, download.suggestedFilename());
  await download.saveAs(path);
  expect(statSync(path).size).toBeGreaterThan(1000);
  return { path, name: download.suggestedFilename() };
}

async function checkArchive(page: Page) {
  await page.goto('/en/backup/');
  await page.getByRole('button', { name: 'Check my archive' }).click();
  const result = page.getByTestId('library-check-result');
  await expect(result).toContainText('Your files are all in place', { timeout: 60_000 });
  await expect(result).toContainText('3 files were checked and all are complete.');
}

test('ten people, two backups, restored on a clean browser and over an existing library: identical, nothing foreign', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'ma-backup-e2e-'));
  const foreign: string[] = [];
  const contexts: Awaited<ReturnType<typeof freshContext>>['context'][] = [];
  try {
    // 1. The library, and what it looks like.
    await buildLibrary(page);
    const original = await snapshot(page);
    expect(original.counts).toMatch(/10 people/);
    expect(original.counts).toMatch(/4 conversations/);
    expect(original.counts).toMatch(/17 messages/);
    expect(original.counts).toMatch(/3 photos, videos and audio files/);
    expect(original['Mama/conversations']).toMatch(/6 messages/);
    expect(original['Mama/notes']).toContain('Ella ho cantava cada dia.');
    expect(original['Mama/notes']).toContain('La meva mare.');
    expect(original['Papa/favorites']).toContain('00000002-PHOTO');

    // 2. Two full backups of the same state.
    const plain = await makeBackup(page, dir);
    expect(plain.name).toMatch(/\.zip$/);
    const protectedBackup = await makeBackup(page, dir, PASSWORD);
    expect(protectedBackup.name).toMatch(/\.mabackup$/);
    await checkArchive(page);

    // 3. A fresh browser (the original computer is lost): open the plain backup.
    const second = await freshContext(browser, testInfo, foreign);
    contexts.push(second.context);
    await second.page.goto('/en/backup/');
    await expect(second.page.getByTestId('backup-counts')).not.toContainText('Counting');
    await second.page.getByTestId('restore-input').setInputFiles(plain.path);
    await expect(second.page.getByText('The archive is open. Everything is on this device.')).toBeVisible({ timeout: 90_000 });
    expect(await snapshot(second.page)).toEqual(original);
    await checkArchive(second.page);

    // 4. Another fresh browser: the protected one. A wrong password changes nothing and asks again.
    const third = await freshContext(browser, testInfo, foreign);
    contexts.push(third.context);
    await third.page.goto('/en/backup/');
    await expect(third.page.getByTestId('backup-counts')).not.toContainText('Counting');
    await third.page.getByTestId('restore-input').setInputFiles(protectedBackup.path);
    const prompt = third.page.getByTestId('password-prompt');
    await prompt.getByLabel('Password').fill('not the password');
    await prompt.getByRole('button', { name: 'Open backup' }).click();
    await expect(prompt.getByText('That password does not open this backup.')).toBeVisible({ timeout: 60_000 });
    await expect(third.page.getByTestId('backup-counts')).toContainText('0 people');
    await prompt.getByLabel('Password').fill(PASSWORD);
    await prompt.getByRole('button', { name: 'Open backup' }).click();
    await expect(third.page.getByText('The archive is open. Everything is on this device.')).toBeVisible({ timeout: 90_000 });
    expect(await snapshot(third.page)).toEqual(original);
    await checkArchive(third.page);

    // 5. A media file really opens after the restore (not only counted).
    await openPerson(third.page, 'Avi');
    await third.page.getByRole('link', { name: /Ana i Avi/ }).first().click();
    const photo = third.page.locator('[role="feed"] article img').first();
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // 6. A third browser that already has something: replace it with the protected backup.
    const fourth = await freshContext(browser, testInfo, foreign);
    contexts.push(fourth.context);
    await startFresh(fourth.page);
    await addPerson(fourth.page, 'Persona Provisional');
    await importFromPeople(fourth.page, chatZip('Provisional', 9), 'Persona Provisional', 'Add 4 messages to Persona Provisional');
    await expect(fourth.page.getByText('4 new messages added to Persona Provisional.')).toBeVisible();
    await fourth.page.goto('/en/backup/');
    await expect(fourth.page.getByTestId('backup-counts')).toContainText('1 person');
    const downloads: Download[] = [];
    fourth.page.on('download', (download) => downloads.push(download));
    await fourth.page.getByTestId('replace-input').setInputFiles(protectedBackup.path);
    const dialog = fourth.page.getByRole('dialog');
    await expect(dialog.getByTestId('replace-counts')).toContainText('1 person');
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Replace my archive', exact: true }).click();
    await expect(fourth.page.getByText('Your archive was replaced with the backup. Everything is on this device.')).toBeVisible({ timeout: 120_000 });
    // The safety copy of what was there reached the browser before the swap.
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.suggestedFilename()).toMatch(/\.zip$/);
    await expect(fourth.page.getByText(/Your browser was offered a safety copy of your archive named /)).toBeVisible();
    const afterReplace = await snapshot(fourth.page);
    expect(afterReplace).toEqual(original);
    await expect(fourth.page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Persona Provisional' })).toHaveCount(0);
    await checkArchive(fourth.page);

    expect(foreign, 'requests to non-local origins from the extra contexts').toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
