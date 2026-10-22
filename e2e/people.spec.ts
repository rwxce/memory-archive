import { addPerson, expect, overflowsHorizontally, startFresh, test, personMenu } from './fixtures';

test('first run shows the welcome, and Start leads to an empty People screen', async ({ page }) => {
  await page.goto('/en/');
  await expect(page.getByRole('heading', { level: 1, name: 'Keep their words close' })).toBeVisible();
  await expect(page.getByText('Everything stays on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/en\/people\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No one here yet' })).toBeVisible();
});

test('a created person survives a reload (OPFS persistence)', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test', 'friend');
  await expect(page.getByText('Ada Test was added.')).toBeVisible();

  await page.reload();
  const list = page.getByRole('list', { name: 'People' });
  await expect(list.getByRole('link', { name: 'Ada Test' })).toBeVisible();
  await expect(list.getByText('friend')).toBeVisible();
  await expect(list.getByText('No conversations yet')).toBeVisible();
});

test('edit changes the name and the change is kept', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Ada Test' }).click();
  await personMenu(page, 'Ada Test', 'Edit Ada Test');
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Ada Test' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Ada Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Renamed' })).toBeVisible();

  await page.goto('/en/people/');
  const list = page.getByRole('list', { name: 'People' });
  await expect(list.getByRole('link', { name: 'Ada Renamed' })).toBeVisible();
  await expect(list.getByRole('link', { name: 'Ada Test' })).toHaveCount(0);
  await page.reload();
  await expect(list.getByRole('link', { name: 'Ada Renamed' })).toBeVisible();
});

test('archive asks first, moves to Archived, and restore brings the person back', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Ada Test' }).click();
  await personMenu(page, 'Ada Test', 'Archive Ada Test');
  await expect(page.getByText('Archive Ada Test?')).toBeVisible();

  // Cancel changes nothing.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Archive Ada Test?')).toHaveCount(0);

  await personMenu(page, 'Ada Test', 'Archive Ada Test');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Ada Test is now archived.')).toBeVisible();

  await page.goto('/en/people/');
  await expect(page.getByRole('heading', { name: 'No one here yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Show archived people (1)' }).click();
  await expect(page.getByRole('main').getByRole('link', { name: 'Ada Test' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Show archived people (1)' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Ada Test' }).click();

  await personMenu(page, 'Ada Test', /^Restore Ada Test/);
  await expect(page.getByText('Ada Test is back in the list.')).toBeVisible();
  await page.goto('/en/people/');
  await expect(page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Ada Test' })).toBeVisible();
  await expect(page.getByRole('button', { name: /archived people/ })).toHaveCount(0);
});

test('the person page opens and shows the no-conversations empty state', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');
  await page.getByRole('main').getByRole('link', { name: 'Ada Test' }).click();
  await expect(page).toHaveURL(/\/en\/person\/\?id=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Test' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByText('No conversations are kept under Ada Test yet.')).toBeVisible();

  await page.getByRole('link', { name: 'People', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
});

test('Escape closes the form without saving', async ({ page }) => {
  await startFresh(page);
  await page.getByRole('button', { name: 'Add a person' }).click();
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('Never Saved');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Never Saved' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No one here yet' })).toBeVisible();
});

test('an empty name is explained next to the field', async ({ page }) => {
  await startFresh(page);
  await page.getByRole('button', { name: 'Add a person' }).click();
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('Write a name to continue.')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
});

test('no horizontal overflow on welcome, People, form and person page', async ({ page }) => {
  await page.goto('/en/');
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  await page.getByRole('button', { name: 'Add a person' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
  await page.getByLabel('Name', { exact: true }).fill('Ada Test');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByRole('main').getByRole('link', { name: 'Ada Test' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);

  await page.getByRole('main').getByRole('link', { name: 'Ada Test' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Test' })).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
});

test('a long unbroken name does not overflow the list, the edit form or the person page', async ({ page }) => {
  const long = 'W'.repeat(60);
  // Wide monospace with letter spacing on everything: the check must not depend on which fallback font the machine has.
  const wideFont = () => page.addStyleTag({ content: '* { font-family: monospace !important; letter-spacing: 1em !important; }' });
  await startFresh(page);
  await wideFont();
  await addPerson(page, long);
  expect(await overflowsHorizontally(page)).toBe(false);

  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: long }).click();
  await expect(page.getByRole('heading', { level: 1, name: long })).toBeVisible();
  await wideFont();
  expect(await overflowsHorizontally(page)).toBe(false);

  // The same confirmation on the person page.
  await personMenu(page, long, `Archive ${long}`);
  await expect(page.getByText(`Archive ${long}?`)).toBeVisible();
  expect(await overflowsHorizontally(page)).toBe(false);
});
