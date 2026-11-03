import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { addPerson, expect, overflowsHorizontally, startFresh, test } from './fixtures';

// The "Copy to read on a computer" card on the backup screen, against the built app: synthetic people only.
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
