import { defineConfig } from '@playwright/test';

// README screenshots of the built PWA on synthetic Catalan data (`pnpm build`, then
// `pnpm screenshots`). A separate config so `pnpm e2e` never runs it (playwright.config.ts
// ignores e2e/screenshots.spec.ts). Writes docs/screenshots/*.png. Uses the system Chrome and a
// local preview server only: no network, no browser download.
const PORT = Number(process.env.PORT ?? 4175);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'screenshots.spec.ts',
  // One browser at a time: each project imports six chats into its own fresh OPFS.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  outputDir: 'test-results/screenshots',
  use: {
    baseURL,
    channel: 'chrome',
    locale: 'ca-ES',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
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
