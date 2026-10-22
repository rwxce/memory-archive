import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * README screenshots, not a test of behavior: `pnpm build && pnpm screenshots`. It imports the
 * synthetic Catalan "showcase" chats (scripts/showcase-fixtures.mjs, written to fixtures/showcase/
 * by `pnpm test`) into a fresh browser, then captures the main screens into docs/screenshots/.
 * Labels come from messages/ca.json, so a copy change does not break the flow. Run by its own
 * config (playwright.screenshots.config.ts): the project decides which shots are taken.
 */

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SHOWCASE = path.join(ROOT, 'fixtures', 'showcase');
const ca = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', 'ca.json'), 'utf8')) as Record<string, unknown>;

/** A Catalan message by dotted key, with `{name}`-style placeholders filled (no plurals needed here). */
function t(key: string, values: Record<string, string> = {}): string {
  const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], ca);
  if (typeof text !== 'string') throw new Error(`messages/ca.json has no string at ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

const QUOTE = '«Sempre deia que el millor moment del dia era el cafè de les cinc.»';
const NUMBER = '[\\d.,\\s]+'; // 1.204: digits, separators, no-break spaces

interface Person {
  name: string;
  relation: string;
  description?: string;
}
/** Showcase chats in import order; `person` is who the chat is kept under (undefined: decide later). */
const CHATS: { zip: string; person?: string }[] = [
  { zip: 'Mama', person: 'Mama' },
  { zip: 'Avi Josep', person: 'Avi Josep' },
  { zip: 'Laia', person: 'Laia' },
  { zip: 'Marc', person: 'Marc' },
  { zip: 'Família Puig', person: 'Mama' },
  { zip: 'Sopars dels dijous' },
];
const PEOPLE: Person[] = [
  { name: 'Mama', relation: 'Mare', description: QUOTE },
  { name: 'Avi Josep', relation: 'Avi' },
  { name: 'Laia', relation: 'Germana' },
  { name: 'Marc', relation: 'Amic' },
];

/** No animation, no caret, no scrollbars: a still, repeatable picture. */
const STILL = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  ::-webkit-scrollbar { display: none !important; }
  html { scrollbar-width: none !important; }
`;

/** Waits until fonts are ready and every image on the page has decoded (no placeholders in the shot). */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: STILL });
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.images].filter((img) => !(img.complete && img.naturalWidth > 0)).length,
        ),
      { timeout: 20_000 },
    )
    .toBe(0);
  await page.waitForTimeout(400);
}

async function shoot(page: Page, device: string, scheme: string, name: string): Promise<void> {
  await settle(page);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${device}-${scheme}-${name}.png`), scale: 'css', animations: 'disabled', caret: 'hide' });
}

async function addPerson(page: Page, { name, relation, description }: Person): Promise<void> {
  await page.getByRole('button', { name: t('people.add') }).click();
  await page.getByLabel(t('people.form.name'), { exact: true }).fill(name);
  await page.getByLabel(t('people.form.relationship')).fill(relation);
  if (description) await page.getByLabel(t('people.form.description')).fill(description);
  await page.getByRole('button', { name: t('people.form.create') }).click();
  await expect(page.getByRole('list', { name: t('people.title') }).getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
}

/** From the People screen: the whole import wizard for one showcase ZIP. */
async function importChat(page: Page, { zip, person }: { zip: string; person?: string }): Promise<void> {
  const next = () => page.getByRole('button', { name: t('import.wizard.next') }).click();
  await page.goto('/ca/import/');
  await page.getByTestId('import-file-input').setInputFiles(path.join(SHOWCASE, `WhatsApp Chat - ${zip}.zip`));
  await page.getByRole('button', { name: /^Continua amb 1 fitxer$/ }).click();
  await expect(page.getByText(new RegExp(`^${NUMBER} missatges?$`))).toBeVisible({ timeout: 90_000 });
  await next();
  const choice = person ? new RegExp(`^${person}`) : new RegExp(`^${t('import.person.later')}`);
  const pick = async (name: RegExp) => {
    const radio = page.getByRole('radio', { name });
    // Centered first: on a phone the last choice can sit under the sticky Back / Next bar.
    await radio.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await radio.click({ force: true });
    await expect(radio).toBeChecked();
  };
  await pick(choice);
  await next();
  await pick(/^Tu(\s|$)/);
  await next();
  await expect(page.getByRole('heading', { level: 2, name: t('import.steps.check') })).toBeVisible({ timeout: 30_000 });
  await next();
  const confirm = person ? new RegExp(`^Afegeix ${NUMBER} missatges a ${person}$`) : new RegExp(`^Afegeix ${NUMBER} missatges, encara sense assignar$`);
  await page.getByRole('button', { name: confirm }).click();
  await expect(page.getByRole('heading', { name: t('import.done.titleOk') })).toBeVisible({ timeout: 120_000 });
}

/** On the conversation screen: star a message and add a note to another. */
async function curate(page: Page): Promise<void> {
  const message = (text: string) => page.getByRole('article').filter({ hasText: text });
  for (const text of ['Bon dia, carinyo', 'Mira com han quedat les tomaqueres', 'Vens a dinar? He fet canelons']) {
    const row = message(text);
    await row.scrollIntoViewIfNeeded();
    await row.getByRole('button', { name: t('conversation.favorite.add') }).click();
    await expect(row.getByRole('button', { name: t('conversation.favorite.remove') })).toBeVisible();
  }
  const row = message('Vens a dinar? He fet canelons');
  await row.getByRole('button', { name: t('notes.addButton') }).click();
  await page.getByLabel(t('notes.label.message')).fill('Els canelons de la mama, com sempre. Vam riure molt aquell dia.');
  await page.getByRole('button', { name: t('notes.save') }).click();
  await expect(page.getByText(t('notes.saved'))).toBeVisible();
}

async function openPerson(page: Page, name: string): Promise<void> {
  await page.goto('/ca/people/');
  await page.getByRole('list', { name: t('people.title') }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByRole('navigation', { name: t('person.sectionsLabel') })).toBeVisible();
}

/** From a person's page: a conversation, opened on a given day (`&date=` is what Timeline and Search links use). */
async function openConversation(page: Page, title: string, day: string): Promise<void> {
  const href = await page.getByRole('link', { name: t('conversations.openLabel', { title }) }).getAttribute('href');
  await page.goto(`${href}&date=${day}`);
  await expect(page.getByRole('article').filter({ hasText: 'Bon dia, carinyo' })).toBeVisible();
}

async function peopleReady(page: Page): Promise<void> {
  await page.goto('/ca/people/');
  const list = page.getByRole('list', { name: t('people.title') });
  await expect(list.getByRole('link', { name: /^Mama/ })).toBeVisible();
  await expect(page.getByText('Sopars dels dijous').first()).toBeVisible();
}

test('README screenshots', async ({ page }, testInfo) => {
  const device = testInfo.project.name;
  const mobile = device === 'mobile';

  // First run: the welcome screen, in both schemes, before anything is stored.
  await page.goto('/ca/');
  await expect(page.getByRole('button', { name: t('welcome.start') })).toBeVisible();
  if (mobile) {
    await shoot(page, device, 'light', 'welcome');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, device, 'dark', 'welcome');
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await page.getByRole('button', { name: t('welcome.start') }).click();
  await expect(page.getByRole('heading', { level: 1, name: t('people.title') })).toBeVisible();

  // Seed: people, then every showcase chat.
  for (const person of PEOPLE) await addPerson(page, person);
  for (const chat of CHATS) await importChat(page, chat);

  // Favorites and a note, made where a person would make them: in the conversation.
  await openPerson(page, 'Mama');
  await openConversation(page, 'Mama', '2019-09-14');
  await curate(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const take = (name: string) => shoot(page, device, scheme, name);

    await peopleReady(page);
    if (mobile) await take('people');

    await openPerson(page, 'Mama');
    await expect(page.getByText('Sempre deia')).toBeVisible();
    await take('person');

    if (!mobile && scheme === 'light') {
      await openConversation(page, 'Mama', '2019-09-14');
      await take('conversation');
      await openPerson(page, 'Mama');
    }
    if (!mobile) continue;

    await openConversation(page, 'Mama', '2019-09-14');
    await expect(page.getByRole('article').filter({ hasText: 'Mira com han quedat les tomaqueres' })).toBeVisible();
    await take('conversation');

    await openPerson(page, 'Mama');
    await page.getByRole('navigation', { name: t('person.sectionsLabel') }).getByRole('link', { name: new RegExp(`^${t('person.sectionGallery')}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: t('person.sectionGallery') })).toBeVisible();
    await expect(page.locator('section li button img').first()).toBeVisible();
    await take('gallery');

    await page.goto('/ca/search/?q=tomaqueres');
    await expect(page.getByText(/^\d+ resultats?$/).first()).toBeVisible({ timeout: 60_000 });
    await take('search');

    await page.goto('/ca/settings/');
    await expect(page.getByRole('heading', { level: 1, name: t('settings.title') })).toBeVisible();
    await take('settings');
  }
});
