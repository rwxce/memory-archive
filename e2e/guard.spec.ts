import { expect, test } from './fixtures';

// Self-test of the no-external-requests guard: it must be able to fail.
test.use({ allowForeignRequests: true });

test('the guard records a request to a foreign origin and ignores local and data: ones', async ({ page, foreignRequests }) => {
  await page.goto('/en/welcome/');
  expect(foreignRequests).toEqual([]);

  // .invalid never resolves, but the browser still issues (and the context sees) the request.
  await page.evaluate(() => fetch('http://example.invalid/probe').catch(() => undefined));
  await expect.poll(() => foreignRequests).toEqual(['http://example.invalid/probe']);

  await page.evaluate(() => fetch('data:text/plain,hello'));
  await page.evaluate(() => fetch('/manifest.webmanifest'));
  expect(foreignRequests).toEqual(['http://example.invalid/probe']);
});
