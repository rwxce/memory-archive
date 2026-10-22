// Build the database worker into public/db/ (run before `next dev` / `next build`):
//
//   public/db/worker.js     lib/db/worker.ts + SQLite WASM glue, one ES module (esbuild)
//   public/db/sqlite3.wasm  the SQLite binary, copied from @sqlite.org/sqlite-wasm
//   public/db/import-worker.js  lib/usecases/import-worker.ts: the import (parse, inflate, hash,
//                           blob writes) in its own worker. No SQLite inside: it reaches the
//                           database worker through a MessagePort the page brokers.
//
// Why not let Next.js bundle the worker: the sqlite-wasm entry also contains a
// legacy worker wrapper that does `new Worker(new URL(variable, import.meta.url))`,
// which Turbopack rejects at build time. esbuild leaves that line alone (the
// code path is never used: we use the SAH-pool VFS) and keeps
// `new URL('sqlite3.wasm', import.meta.url)`, which resolves to the .wasm
// sitting next to worker.js: same origin, no CDN.
//
// Files in public/ are copied to out/ by `next build`, so the service worker
// (scripts/build-sw.mjs) precaches both and the database works offline.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const DB_WORKER_DIR = path.join('public', 'db');
export const DB_WORKER_FILE = 'worker.js';
export const DB_WASM_FILE = 'sqlite3.wasm';
export const IMPORT_WORKER_FILE = 'import-worker.js';

export async function buildDbWorker({ root = process.cwd(), outDir = path.join(root, DB_WORKER_DIR) } = {}) {
  const require = createRequire(path.join(root, 'package.json'));
  const wasm = require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [entry, file] of [
    [path.join('lib', 'db', 'worker.ts'), DB_WORKER_FILE],
    [path.join('lib', 'usecases', 'import-worker.ts'), IMPORT_WORKER_FILE],
  ]) {
    await build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outDir, file),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      tsconfig: path.join(root, 'tsconfig.json'),
      logLevel: 'warning',
    });
  }
  fs.copyFileSync(wasm, path.join(outDir, DB_WASM_FILE));
  return { outDir, worker: path.join(outDir, DB_WORKER_FILE), importWorker: path.join(outDir, IMPORT_WORKER_FILE), wasm: path.join(outDir, DB_WASM_FILE) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDbWorker()
    .then(({ worker, importWorker, wasm }) => {
      const kib = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KiB`;
      console.log(`[db-worker] wrote ${DB_WORKER_DIR}/${DB_WORKER_FILE} (${kib(worker)}) and ${DB_WASM_FILE} (${kib(wasm)}), ${IMPORT_WORKER_FILE} (${kib(importWorker)})`);
    })
    .catch((e) => {
      console.error(`[db-worker] FAIL: ${e.message}`);
      process.exit(1);
    });
}
