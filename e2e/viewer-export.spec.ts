import { strToU8, unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test } from './fixtures';

// The "Export a copy" card on the backup screen, against the built app: synthetic people only.
// Needs `pnpm build` (the viewer template is a bundled asset). Screenshots go to .context/.

test('the viewer copy is made from the backup screen and downloads a ZIP with viewer.html', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Ana');
  await addPerson(page, 'Luis');
  await page.goto('/en/backup/');
  const card = page.getByTestId('viewer-export');
  await expect(card.getByRole('checkbox', { name: 'Ana' })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Luis' })).toBeChecked();
  await card.scrollIntoViewIfNeeded();
  expect(await overflowsHorizontally(page)).toBe(false);
  await card.screenshot({ path: `.context/viewer-export-${testInfo.project.name}.png` });

  const downloading = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Make the copy' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^memory-archive-viewer-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(readFileSync((await download.path())!));
  expect(Object.keys(files)).toContain('viewer.html');
  await expect(page.getByTestId('viewer-export-result')).toContainText('was handed to your browser');
  await card.screenshot({ path: `.context/viewer-export-done-${testInfo.project.name}.png` });
});

const zipOf = (name: string, lines: string[]) => ({ name, mimeType: 'application/zip', buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(lines.join('\n')) })) });
const chat = (other: string) => [1, 2, 3].map((n) => `[1${n}/03/2026, 08:0${n}:00] ${n % 2 ? other : 'Ana'}: Synthetic message ${n}`);

test('web pages are made one folder per person and download a ZIP with the pages', async ({ page }, testInfo) => {
  await startFresh(page);
  for (const [person, other] of [['Mama', 'Bo'], ['Papa', 'Cy']] as const) {
    await addPerson(page, person);
    await importFromPeople(page, zipOf(`WhatsApp Chat - ${other}.zip`, chat(other)), person, /^Add [\d,]+ messages to /);
    await expect(page.getByText(new RegExp(`new messages added to ${person}\\.`))).toBeVisible();
    await page.goto('/en/people/');
  }
  await page.goto('/en/backup/');
  const card = page.getByTestId('viewer-export');
  await card.getByRole('radio', { name: /Web pages \(HTML\)/ }).check();
  await card.getByRole('radio', { name: 'One folder for each person' }).check();
  await card.scrollIntoViewIfNeeded();
  expect(await overflowsHorizontally(page)).toBe(false);
  await card.screenshot({ path: `.context/viewer-export-html-${testInfo.project.name}.png` });

  const downloading = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Make the copy' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^memory-archive-html-\d{4}-\d{2}-\d{2}\.zip$/);
  const names = Object.keys(unzipSync(readFileSync((await download.path())!)));
  expect(names.filter((name) => name.endsWith('.html')).length).toBeGreaterThanOrEqual(2);
  expect(names.some((name) => name.startsWith('mama/'))).toBe(true);
  expect(names.some((name) => name.startsWith('papa/'))).toBe(true);
  await expect(page.getByTestId('viewer-export-result')).toContainText('was handed to your browser');
});
