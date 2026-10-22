import { strToU8, zipSync } from 'fflate';
import { addPerson, expect, importFromPeople, overflowsHorizontally, startFresh, test, openSection } from './fixtures';

/**
 * A person's Audio screen against the built app, with the real workers and OPFS: a small synthetic
 * chat with three voice messages (two from Ana, who is "me", one from Bo) is imported, then the list
 * is checked (by month, chronological), a file is played, one plays at a time, and "Open in
 * conversation" lands on that day. Set E2E_SHOTS=<dir> to also save screenshots of the screen.
 */
const SILENCE = (() => {
  // A 0.1 s mono 8-bit WAV: a real, playable (silent) file.
  const data = 800;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data, 128)]);
})();

const VOICE = ['00000001-AUDIO-2026-01-10-09-05-00.opus', '00000002-AUDIO-2026-02-11-21-30-00.opus', '00000003-AUDIO-2026-03-14-18-00-00.opus'];
const chat = [
  `[10/01/2026, 09:05:00] Ana: <attached: ${VOICE[0]}>`,
  '[10/01/2026, 09:06:00] Bo: Got it',
  `[11/02/2026, 21:30:00] Bo: <attached: ${VOICE[1]}>`,
  `[14/03/2026, 18:00:00] Ana: <attached: ${VOICE[2]}>`,
].join('\n');
const zip = () => ({
  name: 'WhatsApp Chat - Ana i Bo.zip',
  mimeType: 'application/zip',
  buffer: Buffer.from(zipSync({ '_chat.txt': strToU8(chat), ...Object.fromEntries(VOICE.map((name) => [name, new Uint8Array(SILENCE)])) })),
});

test('a person has an Audio screen: chronological by month, playable one at a time, linked to the conversation', async ({ page }, testInfo) => {
  await startFresh(page);
  await addPerson(page, 'Mama');
  await importFromPeople(page, zip(), 'Mama', /^Add [\d,]+ messages to Mama$/);
  await expect(page.getByText(/new messages added to Mama\./)).toBeVisible();

  // from the person's page, through the sections
  await page.goto('/en/people/');
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Mama' }).click();
  await openSection(page, 'Audio');
  await expect(page).toHaveURL(/\/en\/person\/audio\/\?id=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Audio' })).toBeVisible();
  await expect(page.getByText('3 voice messages and audio files')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Mama' })).toBeVisible();

  // by year, oldest first; nothing is read yet
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['2026']);
  const items = page.locator('section li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Jan 10, 2026, 9:05 AM');
  await expect(items.nth(0)).toContainText('Ana');
  await expect(items.nth(1)).toContainText('Feb 11, 2026, 9:30 PM');
  await expect(items.nth(1)).toContainText('Bo');
  await expect(items.nth(1)).toContainText('Ana i Bo');
  await expect(page.locator('audio')).toHaveCount(0);
  expect(await overflowsHorizontally(page)).toBe(false);

  // Play reads that file and moves the keyboard to its player; another one replaces it
  await items.nth(0).getByRole('button', { name: /^Play voice message/ }).click();
  const hero = page.getByRole('region', { name: 'Now playing' });
  await expect(hero).toBeVisible();
  const player = page.locator('audio');
  await expect(player).toHaveCount(1);
  await expect(player).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => player.evaluate((el: HTMLAudioElement) => el.readyState > 0 || el.error !== null)).toBe(true);
  await items.nth(1).getByRole('button', { name: /^Play voice message/ }).click();
  await expect(hero).toContainText('Bo');
  await expect(page.locator('audio')).toHaveCount(1);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/person-audio-${testInfo.project.name}.png`, fullPage: true });

  // the way to the message: that conversation, on that day, coming from the person
  await hero.getByRole('link', { name: /^Open in conversation/ }).click();
  await expect(page).toHaveURL(/\/en\/conversation\/\?id=[0-9a-f-]{36}&from=[0-9a-f-]{36}&date=2026-02-11$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana i Bo' })).toBeVisible();
  await expect(page.getByRole('feed').locator('article', { hasText: 'Wednesday, February 11, 2026' }).first()).toBeInViewport();
  await page.getByRole('link', { name: 'Back to Mama' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mama' })).toBeVisible();

  // an unknown person is calm, with the way back
  await page.goto('/en/person/audio/?id=00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('heading', { level: 1, name: 'We could not find this person' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to People' }).first()).toBeVisible();
});
