import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// No telemetry, ever (docs/privacy.md). The package scripts also set this
// before `next` starts; this line covers anyone running `next` directly.
process.env.NEXT_TELEMETRY_DISABLED = '1';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Optional sub-path the app is served from, e.g. `/memory-archive` on GitHub
 * Pages. Empty (served from the domain root) by default. Must start with `/`
 * and must not end with one.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
if (basePath && !basePath.startsWith('/')) {
  throw new Error(`NEXT_PUBLIC_BASE_PATH must start with "/" (got "${basePath}")`);
}

const nextConfig: NextConfig = {
  // Static files only: no server, no middleware, no API routes.
  output: 'export',
  // `/en/settings/` → `out/en/settings/index.html`, which every static host
  // (GitHub Pages, Cloudflare Pages, `pnpm preview`) serves without rewrites.
  trailingSlash: true,
  basePath: basePath || undefined,
  images: { unoptimized: true },
  // Never phone home (Next.js telemetry is also disabled in CI via env).
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
