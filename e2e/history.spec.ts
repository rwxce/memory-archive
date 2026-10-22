import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test, walkImport as walk, personMenu } from './fixtures';

/**
 * Import history and the Phase 4 checks against the built app with the real workers and OPFS:
 * the same ZIP twice adds nothing, a newer export adds only the difference, an import can be
 * undone from the history, and closing the tab in the middle of an import leaves the archive
 * intact. Every export is generated here (synthetic, never a real chat, never read from disk).
 */
const PHOTO = '00000001-PHOTO-2026-03-17-13-20-00.jpg';
const BASE = [
  '[17/03/2026, 13:17:05] Ana: Bon dia',
  '[17/03/2026, 13:17:30] Bo: Hola',
  `[17/03/2026, 13:20:00] Ana: <attached: ${PHOTO}>`,
  '[18/03/2026, 09:10:00] Bo: Fins demà',
];
const NEWER = [...BASE, '[19/03/2026, 10:00:00] Ana: Una nova', '[19/03/2026, 10:05:00] Bo: Dues noves'];
const NAME = 'WhatsApp Chat - Ana i Bo.zip';

function exportZip(lines: string[] = BASE) {
  const photo = new Uint8Array(512).map((_, i) => (i * 7 + 1) % 251);
  return { name: NAME, mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')), [PHOTO]: photo })) };
}

const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 2, name });
const next = (page: Page) => page.getByRole('button', { name: 'Next' }).click();

const importAnother = async (page: Page, file: Parameters<typeof walk>[1], person: string, confirm: string | RegExp) => {
  await page.getByRole('button', { name: 'Import another chat' }).click();
  await walk(page, file, person, confirm);
};

const entries = (page: Page) => page.locator('ul[aria-label="Imports"] > li');
const seeHistory = (page: Page) => page.getByRole('link', { name: 'See import history' }).click();

test('the same ZIP twice adds nothing: one entry in the history, and the counts do not change', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, exportZip(), 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();
  await seeHistory(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Import history' })).toBeVisible();
  await expect(entries(page)).toHaveCount(1);
  let entry = entries(page).first();
  await expect(entry.getByRole('heading', { name: 'Ana i Bo' })).toBeVisible();
  await expect(entry.getByText(NAME)).toBeVisible();
  await expect(entry.getByText('4 new messages added.')).toBeVisible();
  await expect(entry.getByText('This import created the conversation.')).toBeVisible();
  await expect(entry.getByText('1 message still has its photo or file.')).toBeVisible();
  await expect(entry.getByRole('link', { name: 'Mama' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  // The same file again, from the history's own way back into the wizard.
  await page.getByRole('link', { name: 'Back to People' }).click();
  await importFromPeople(page, exportZip(), 'Mama', 'Finish without adding anything');
  await expect(page.getByText('No new messages were added to Mama.')).toBeVisible();
  await seeHistory(page);
  await expect(entries(page)).toHaveCount(1);
  entry = entries(page).first();
  await expect(entry.getByText('4 new messages added.')).toBeVisible();

  // People and the person's page: still one conversation with 4 messages.
  await page.getByRole('link', { name: 'Back to People' }).click();
  await expect(page.getByText(/1 conversation/)).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Mama', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Conversations' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText(/4 messages/)).toBeVisible();
});

test('a newer export adds only the difference', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, exportZip(), 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();

  await importAnother(page, exportZip(NEWER), 'Mama', 'Add 2 messages to Mama');
  await expect(page.getByText('2 new messages added to Mama.')).toBeVisible();
  await expect(page.getByText('4 messages were already in the archive and were not copied again.')).toBeVisible();
  await expect(page.getByText('Added to the conversation “Ana i Bo”.')).toBeVisible();

  await seeHistory(page);
  await expect(entries(page)).toHaveCount(2);
  const [newest, oldest] = [entries(page).nth(0), entries(page).nth(1)];
  await expect(newest.getByText('2 new messages added.')).toBeVisible();
  await expect(newest.getByText('4 messages were already in the archive.')).toBeVisible();
  await expect(newest.getByText('This import created the conversation.')).toHaveCount(0);
  await expect(oldest.getByText('4 new messages added.')).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  await page.getByRole('link', { name: 'Mama', exact: true }).first().click();
  await expect(page.getByRole('list', { name: 'Conversations' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText(/6 messages/)).toBeVisible();

  // From the person's page: only this person's imports.
  await personMenu(page, 'Mama', 'Imports for this person');
  await expect(page).toHaveURL(/\/en\/import\/history\/\?person=/);
  await expect(page.getByText('Imports into the conversations kept under Mama.')).toBeVisible();
  await expect(entries(page)).toHaveCount(2);
});

test('undo from the history removes that import: its messages and the conversation it created', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, exportZip(), 'Mama', 'Add 4 messages to Mama');
  await expect(page.getByText('4 new messages added to Mama.')).toBeVisible();
  await seeHistory(page);

  await page.getByRole('button', { name: 'Undo this import: Ana i Bo' }).click();
  const panel = page.getByRole('group', { name: 'Undo this import?' });
  await expect(panel.getByText(/The 4 messages this import added will be removed/)).toBeVisible();
  await expect(panel.getByText(/Messages from other imports, and anything that was in your archive before, stay\./)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Keep it' })).toBeFocused();
  expect(await overflowsHorizontally(page)).toBe(false);

  // Escape keeps it, and the focus goes back to the button that opened the question.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo this import: Ana i Bo' })).toBeFocused();
  await expect(entries(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Undo this import: Ana i Bo' }).click();
  await panel.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('The import was undone. 4 messages were removed.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing has been imported yet' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Import history' })).toBeFocused();

  await page.getByRole('link', { name: 'Back to People' }).click();
  await expect(page.getByRole('list', { name: 'People' }).getByText('No conversations yet')).toBeVisible();
});

test('Catalan: the history and its empty state are in Catalan, and the settings link reaches it', async ({ page }) => {
  await page.goto('/ca/settings/');
  await page.getByRole('link', { name: /Historial d’importacions/ }).click();
  await expect(page).toHaveURL(/\/ca\/import\/history\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Historial d’importacions' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Encara no s’ha importat res' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
});

// ── Phase 4: closing the tab in the middle of an import leaves the archive intact ─────────────
//
// What these tests show is the browser-level behaviour: a tab that dies while the files are being
// copied leaves no trace, and the archive is usable and importable afterwards. The all-or-nothing
// guarantee itself is held by the unit / integration tests, which compare the full state of every
// table and the blob listing before and after an interruption (lib/usecases/import.test.ts:
// "abort between two media files leaves the archive and the store as they were", "an abort while a
// media stream is being copied stops the copy and leaves nothing", "the store failing in the blob
// phase leaves the database untouched and removes the blobs written so far", "the database refusing
// the save rolls everything back (conversation, batch, messages) and cleans the blobs", "a lost
// connection at the save step is ambiguous: the blobs stay, the database is unchanged, and the sweep
// removes them"; lib/usecases/import-client.test.ts for the worker being stopped).

const TOTAL_MEDIA = 300;
const TEXT_LINES = 2000;
const TOTAL_MESSAGES = TOTAL_MEDIA + TEXT_LINES;
const MESSAGES_LABEL = TOTAL_MESSAGES.toLocaleString('en-US');

/**
 * A large synthetic export: thousands of messages and hundreds of different files (unique bytes
 * each, stored without compression), so the copy of the files takes seconds. Written to a
 * temporary folder (the browser's file API takes a path for files this big).
 */
function bigExport(dir: string): string {
  const lines: string[] = [];
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  // Days above 12, so the day-first reading is the only possible one and the wizard does not ask.
  const start = Date.UTC(2026, 2, 17);
  const stamp = (n: number) => {
    const d = new Date(start + n * 60_000);
    const p = (x: number) => String(x).padStart(2, '0');
    return `[${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00]`;
  };
  for (let i = 0; i < TEXT_LINES + TOTAL_MEDIA; i++) {
    const author = i % 2 ? 'Bo' : 'Ana';
    const made = Object.keys(files).length;
    if (i % 7 === 3 && made < TOTAL_MEDIA) {
      const name = `${String(made + 1).padStart(8, '0')}-PHOTO-2026-01-01-00-00-00.jpg`;
      let x = (made + 1) * 2654435761;
      const bytes = new Uint8Array(64_000);
      for (let k = 0; k < bytes.length; k++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        bytes[k] = x & 255;
      }
      files[name] = [bytes, { level: 0 }];
      lines.push(`${stamp(i)} ${author}: <attached: ${name}>`);
    } else {
      lines.push(`${stamp(i)} ${author}: Message number ${i}`);
    }
  }
  const path = join(dir, 'WhatsApp Chat - Ana i Bo.zip');
  writeFileSync(path, zipSync({ '_chat.txt': strToU8(lines.join('\n')), ...files } as never));
  return path;
}

async function startBigImport(page: Page, file: string) {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await page.getByRole('link', { name: /^Import( a chat)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import a chat' })).toBeVisible();
  await page.getByTestId('import-file-input').setInputFiles(file);
  await page.getByRole('button', { name: 'Continue with 1 file' }).click();
  await expect(page.getByText(new RegExp(`^${MESSAGES_LABEL} messages$`))).toBeVisible({ timeout: 60_000 });
  await next(page);
  await expect(heading(page, /Who is this for/)).toBeFocused();
  await page.getByRole('radio', { name: /^Mama/ }).check();
  await next(page);
  await expect(heading(page, /Which one is you/)).toBeFocused();
  await page.getByRole('radio', { name: /^Ana/ }).check();
  await next(page);
  await expect(heading(page, /What is new/)).toBeFocused({ timeout: 30_000 });
  await next(page);
  await expect(heading(page, /Check and confirm/)).toBeFocused();
  await page.getByRole('button', { name: new RegExp(`^Add ${MESSAGES_LABEL} messages to Mama$`) }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Adding your messages' })).toBeVisible();
  // A real sign of progress, not only the phase label: some files are already copied, not all of them.
  await expect(page.getByText(new RegExp(`Copying photos and files….*\\b[1-9]\\d* of ${TOTAL_MEDIA} files`)).first()).toBeVisible({ timeout: 60_000 });
}

/** The archive after the interruption, seen from a fresh page: nothing was kept, and it still works. */
async function expectNothingKept(page: Page) {
  await page.goto('/en/people/');
  await expect(page.getByRole('list', { name: 'People' }).getByRole('listitem').filter({ hasText: 'Mama' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('main').getByRole('link', { name: 'Mama', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();
  // The importer saves everything in one transaction after the files are copied. If the import
  // finished before the tab was closed, this window was too short: make the ZIP bigger.
  await expect(
    page.getByText('No conversations are kept under Mama yet.'),
    'the import finished before the tab was closed: the test window is too short, not an app failure',
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Conversations' })).toHaveCount(0);

  await page.goto('/en/import/history/');
  await expect(page.getByRole('heading', { level: 1, name: 'Import history' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing has been imported yet' })).toBeVisible();
  await expect(entries(page)).toHaveCount(0);
}

/** Importing the same file again ends with every message exactly once. */
async function reimportOnce(page: Page, file: string) {
  await page.goto('/en/people/');
  await importFromPeople(page, file, 'Mama', new RegExp(`^Add ${MESSAGES_LABEL} messages to Mama$`));
  await expect(heading(page, /Import finished/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(`${MESSAGES_LABEL} new messages added to Mama.`)).toBeVisible();
  await page.getByRole('link', { name: 'Open Mama' }).click();
  const conversations = page.getByRole('list', { name: 'Conversations' }).getByRole('listitem');
  await expect(conversations).toHaveCount(1);
  await expect(conversations.getByText(new RegExp(`${MESSAGES_LABEL} messages`))).toBeVisible();
  await page.goto('/en/import/history/');
  await expect(entries(page)).toHaveCount(1);
}

test.describe('a tab that dies in the middle of an import', () => {
  // The big ZIP is built once per worker and removed at the end.
  let dir = '';
  let file = '';
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-archive-e2e-'));
    file = bigExport(dir);
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const how of ['closing the tab', 'reloading the page'] as const) {
    test(`${how} in the middle of an import leaves the archive intact, and importing again works`, async ({ page, context }) => {
      test.setTimeout(240_000);
      await startBigImport(page, file);

      if (how === 'closing the tab') {
        await page.close();
      } else {
        // The browser asks before leaving a running import; this person says yes.
        page.on('dialog', (dialog) => void dialog.accept());
        await page.reload();
        await page.close();
      }

      const fresh = await context.newPage();
      await expectNothingKept(fresh);
      await reimportOnce(fresh, file);
      await fresh.close();
    });
  }
});
