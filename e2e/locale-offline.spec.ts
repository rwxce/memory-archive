import { addPerson, expect, startFresh, test, personMenu } from './fixtures';

test('a cold open of the Catalan page finds the library created on the English one', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');

  // Full navigation: a new document, so the library is opened again from OPFS.
  await page.goto('/ca/people/');
  await expect(page.getByRole('heading', { level: 1, name: 'Persones' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Persones' }).getByRole('link', { name: 'Ada Test' })).toBeVisible();
  // The open has finished (the person is listed), so the notice is really absent.
  await expect(page.getByText('El teu arxiu no es pot obrir ara mateix')).toHaveCount(0);
});

test('the language picker switches to Catalan and the same people are listed', async ({ page }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Language/ }).click();
  await page.getByRole('link', { name: 'Català' }).click();
  await expect(page).toHaveURL(/\/ca\/settings\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Configuració');

  await page.goto('/ca/people/');
  await expect(page.getByRole('list', { name: 'Persones' }).getByRole('link', { name: 'Ada Test' })).toBeVisible();
  await expect(page.getByText('El teu arxiu no es pot obrir ara mateix')).toHaveCount(0);
});

test('Catalan: add, archive with confirmation and restore', async ({ page }) => {
  await page.goto('/ca/');
  await expect(page.getByRole('heading', { level: 1, name: 'Conserva les seves paraules a prop' })).toBeVisible();
  await page.getByRole('button', { name: 'Comença' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Persones' })).toBeVisible();

  await page.getByRole('button', { name: 'Afegeix una persona' }).click();
  await page.getByLabel('Nom', { exact: true }).fill('Anna Prova');
  await page.getByRole('button', { name: 'Afegeix la persona' }).click();
  await expect(page.getByText("S'ha afegit Anna Prova.")).toBeVisible();

  await page.getByRole('list', { name: 'Persones' }).getByRole('link', { name: 'Anna Prova' }).click();
  await personMenu(page, 'Anna Prova', 'Arxiva Anna Prova', 'Més opcions per a Anna Prova');
  await expect(page.getByText('Vols arxivar Anna Prova?')).toBeVisible();
  await page.getByRole('button', { name: 'Arxiva', exact: true }).click();
  await expect(page.getByText("S'ha arxivat Anna Prova.")).toBeVisible();

  await page.goto('/ca/people/');
  await page.getByRole('button', { name: 'Mostra les persones arxivades (1)' }).click();
  await page.getByRole('link', { name: 'Anna Prova' }).click();
  await personMenu(page, 'Anna Prova', /^Restaura Anna Prova/, 'Més opcions per a Anna Prova');
  await expect(page.getByText("S'ha restaurat Anna Prova.")).toBeVisible();
});

test('after the first load the app works offline, people included', async ({ page, context }) => {
  await startFresh(page);
  await addPerson(page, 'Ada Test');
  // Let the service worker finish installing and precaching.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Ada Test' })).toBeVisible();

  // Navigating to another precached page also works offline.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await context.setOffline(false);
});
