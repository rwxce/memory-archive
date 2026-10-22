import { defineConfig } from '@playwright/test';

// End-to-end checks of the built PWA (`pnpm build` first, then `pnpm e2e`).
// Uses the system Google Chrome (`channel: 'chrome'`): no browser download, so
// no install script and nothing fetched from the network. Firefox and WebKit
// projects arrive in Phase 6 together with a browser install step in CI.
const PORT = Number(process.env.PORT ?? 4173);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  // README screenshots have their own config (playwright.screenshots.config.ts, `pnpm screenshots`).
  testIgnore: '**/screenshots.spec.ts',
  // Every test gets a fresh browser context, so a fresh OPFS; tests are independent.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    channel: 'chrome',
    locale: 'en-US',
    // Failure evidence only; nothing is committed (test-results/ is git-ignored).
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'mobile-390',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    },
    {
      name: 'desktop-1440',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    // Serves out/ (pnpm build). Builds nothing itself.
    command: 'pnpm preview',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
    timeout: 30_000,
  },
});
