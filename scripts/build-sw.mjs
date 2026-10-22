// Build the service worker for the static export (run after `next build`):
//
//   1. bundle sw/service-worker.ts (+ serwist) into one classic script (esbuild);
//   2. @serwist/build `injectManifest`: list every file in out/ with a content
//      revision and inject it as `self.__SW_MANIFEST`, writing out/sw.js.
//
// Why not @serwist/next: it hooks into the webpack build, while Next.js 16
// builds with Turbopack and `output: 'export'` has no server for
// @serwist/turbopack's route handler. A post-build step over out/ works with
// any bundler and any basePath, and precaches exactly what is deployed.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { injectManifest } from '@serwist/build';

export const OUT_DIR = 'out';
export const SW_FILE = 'sw.js';

/** What is precached: every app file except the worker itself and source maps. */
export const GLOB_PATTERNS = ['**/*.{html,txt,js,css,json,webmanifest,svg,png,ico,wasm}'];
export const GLOB_IGNORES = [SW_FILE, '**/*.map'];

export async function buildServiceWorker({ root = process.cwd(), basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '' } = {}) {
  const outDir = path.join(root, OUT_DIR);
  if (!fs.existsSync(path.join(outDir, 'index.html'))) {
    throw new Error('out/index.html missing — run `next build` first');
  }
  const base = basePath.replace(/\/+$/, '');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-sw-'));
  try {
    const swSrc = path.join(tmp, SW_FILE);
    await build({
      entryPoints: [path.join(root, 'sw', 'service-worker.ts')],
      outfile: swSrc,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      tsconfig: path.join(root, 'tsconfig.json'),
      define: {
        'process.env.NEXT_PUBLIC_BASE_PATH': JSON.stringify(base),
        'process.env.NODE_ENV': '"production"',
      },
      logLevel: 'warning',
    });
    const result = await injectManifest({
      swSrc,
      swDest: path.join(outDir, SW_FILE),
      globDirectory: outDir,
      globPatterns: GLOB_PATTERNS,
      globIgnores: GLOB_IGNORES,
      // Content-hashed by Next.js: the URL already changes when the file does.
      dontCacheBustURLsMatching: /^_next\/static\//,
      // The SQLite WASM binary (Phase 2) is ~1 MB; keep headroom, refuse surprises.
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
    });
    for (const w of result.warnings) console.warn(`[sw] warning: ${w}`);
    return { count: result.count, size: result.size, warnings: result.warnings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const { count, size, warnings } = await buildServiceWorker();
  if (warnings.length) process.exitCode = 1;
  console.log(`[sw] wrote out/${SW_FILE}: ${count} files precached (${(size / 1024).toFixed(0)} KiB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[sw] FAIL: ${e.message}`);
    process.exit(1);
  });
}
