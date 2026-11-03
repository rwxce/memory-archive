import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The standalone viewer, opened from disk like a user would: file://, no server, synthetic data.
// Needs `pnpm build` (the template is out/viewer/viewer-template.html). Screenshots go to .context/.

const TEMPLATE = path.join(process.cwd(), 'out', 'viewer', 'viewer-template.html');
const HASH = 'c'.repeat(64);
const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function messages(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2021, 0, 1) + i * 6 * 3600 * 1000).toISOString().slice(0, 19);
    out.push({ sentAt: d, type: 'text', author: i % 2 ? 'Me' : 'Ada', isMe: i % 2 === 1, text: i === 1500 ? 'The Camí to the lake' : `Synthetic message ${i}`, media: null, mediaName: '' });
  }
  out.push({ sentAt: '2024-05-01T09:00:00', type: 'image', author: 'Ada', isMe: false, text: 'photo', media: `media/${HASH}.png`, mediaName: 'IMG-0001.png' });
  out.push({ sentAt: '2024-05-01T09:01:00', type: 'image', author: 'Ada', isMe: false, text: '', media: null, mediaName: 'missing-file.jpg' });
  out.push({ sentAt: '2024-05-01T09:02:00', type: 'text', author: EVIL, isMe: false, text: `${EVIL} see https://example.com/page`, media: null, mediaName: '' });
  return out;
}

function exportData() {
  return {
    format: 'memory-archive-viewer',
    schemaVersion: 1,
    generator: { name: 'memory-archive', version: '0.0.0' },
    createdAt: '2025-03-01T12:00:00.000Z',
    selection: { from: null, to: null, includeMedia: true },
    profiles: [
      { id: 'p1', displayName: 'Ada', relationship: '', description: '' },
      { id: 'p2', displayName: 'Bo', relationship: '', description: '' },
    ],
    conversations: [
      { id: 'c1', title: 'Ada and me', source: 'whatsapp', isGroup: false, profileIds: ['p1'], participants: [{ name: 'Ada', isMe: false }, { name: 'Me', isMe: true }], messages: messages(2400) },
      { id: 'c2', title: EVIL, source: 'whatsapp', isGroup: true, profileIds: ['p2'], participants: [], messages: [{ sentAt: '2022-02-02T08:00:00', type: 'text', author: 'Bo', isMe: false, text: 'hello group', media: null, mediaName: '' }] },
    ],
    media: [{ sha256: HASH, path: `media/${HASH}.png`, size: PNG.length, mime: 'image/png' }],
  };
}

/** What `serializeViewerData` does: nothing in the data can close the island. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

test.skip(!fs.existsSync(TEMPLATE), 'run pnpm build first');

test('opens from file://, works offline of any network, and keeps hostile text inert', async ({ page }, testInfo) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-viewer-'));
  try {
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', `${HASH}.png`), PNG);
    const json = safeJson(exportData());
    const html = fs.readFileSync(TEMPLATE, 'utf8').replace('"viewer-data">__VIEWER_DATA__', () => `"viewer-data">${json}`);
    fs.writeFileSync(path.join(dir, 'viewer.html'), html);

    const problems: string[] = [];
    const foreign: string[] = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('request', (r) => !/^(file|data|blob|about):/.test(r.url()) && foreign.push(r.url()));

    await page.goto(`file://${path.join(dir, 'viewer.html')}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Memory Archive' })).toBeVisible();
    await expect(page.getByLabel('Profile')).toBeVisible();
    await page.screenshot({ path: `.context/viewer-${testInfo.project.name}-list.png` });

    await page.getByRole('button', { name: /Ada and me/ }).click();
    // Opens at the end: the last message (hostile, shown as text) and the image from media/.
    await expect(page.getByText('see https://example.com/page', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'https://example.com/page' })).toHaveAttribute('rel', 'noopener noreferrer');
    await page.locator('.thread img').scrollIntoViewIfNeeded();
    await expect(page.locator('.thread img')).toHaveJSProperty('complete', true);
    expect(await page.locator('.thread img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(page.getByText('missing-file.jpg')).toBeVisible();
    expect(await page.locator('.thread li').count()).toBeLessThanOrEqual(450);
    await page.screenshot({ path: `.context/viewer-${testInfo.project.name}-thread.png` });

    // Search a message far from the window; the result opens it highlighted.
    const isPhone = testInfo.project.name.startsWith('mobile');
    if (isPhone) await page.getByRole('button', { name: /^Back to/ }).click();
    await page.getByRole('searchbox', { name: 'Search messages' }).fill('cami');
    await expect(page.getByRole('region', { name: 'Search results' }).getByText('1 message found.')).toBeVisible();
    await page.getByRole('button', { name: /The Camí to the lake/ }).click();
    await expect(page.locator('.msg.hit mark')).toHaveText('Camí');
    await page.screenshot({ path: `.context/viewer-${testInfo.project.name}-search.png` });

    // Timeline: jump to 2024 (collapsed on a phone).
    if (isPhone) await page.getByText('Timeline', { exact: true }).click();
    await page.getByLabel('Year').selectOption('2024');
    await expect(page.getByText('IMG-0001.png', { exact: false }).or(page.locator('.thread img'))).toBeVisible();

    // The hostile group title is text, never markup.
    if (isPhone) await page.getByRole('button', { name: /^Back to/ }).click();
    await page.getByRole('searchbox', { name: 'Search messages' }).fill('');
    await expect(page.getByText(EVIL, { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // Keyboard: a conversation button takes focus and shows a focus ring.
    await page.getByRole('button', { name: /Ada and me/ }).focus();
    await expect(page.getByRole('button', { name: /Ada and me/ })).toBeFocused();

    expect(problems).toEqual([]);
    expect(foreign).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shows a clear message for data from a newer version', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-viewer-'));
  try {
    const json = safeJson({ ...exportData(), schemaVersion: 99 });
    const html = fs.readFileSync(TEMPLATE, 'utf8').replace('"viewer-data">__VIEWER_DATA__', () => `"viewer-data">${json}`);
    fs.writeFileSync(path.join(dir, 'viewer.html'), html);
    await page.goto(`file://${path.join(dir, 'viewer.html')}`);
    await expect(page.getByRole('heading', { name: 'This file cannot be opened' })).toBeVisible();
    await expect(page.getByText('newer version of Memory Archive')).toBeVisible();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fits a 375 px phone without sideways scrolling', async ({ page }, testInfo) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-viewer-'));
  try {
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', `${HASH}.png`), PNG);
    const html = fs.readFileSync(TEMPLATE, 'utf8').replace('"viewer-data">__VIEWER_DATA__', () => `"viewer-data">${safeJson(exportData())}`);
    fs.writeFileSync(path.join(dir, 'viewer.html'), html);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`file://${path.join(dir, 'viewer.html')}`);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `.context/viewer-375-${testInfo.project.name}-list.png` });
    await page.getByRole('button', { name: /Ada and me/ }).click();
    await expect(page.getByText('Synthetic message 2399')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `.context/viewer-375-${testInfo.project.name}-thread.png` });
    await page.getByText('Timeline', { exact: true }).click();
    await page.screenshot({ path: `.context/viewer-375-${testInfo.project.name}-timeline.png` });
    // Touch targets: every control is at least 44 px high.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, select, input:not([type=checkbox]):not([type=range]), summary')]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 43.5)
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(small).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
