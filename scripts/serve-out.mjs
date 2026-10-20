// `pnpm preview`: serve the static export in `out/` on localhost, the way a
// static host would (trailing-slash directories → index.html, 404.html for
// unknown paths, optional NEXT_PUBLIC_BASE_PATH prefix). No dependencies.
//
//   pnpm build && pnpm preview          # http://localhost:4173/
//   PORT=5000 pnpm preview
//
// A PWA needs a secure context: http://localhost counts as one, so service
// workers and OPFS work here exactly as on the HTTPS deploy.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside `root`, or null. Never escapes `root`
 * (`..`, encoded slashes, absolute paths all resolve inside or fail).
 */
export function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, '.' + path.posix.normalize('/' + decoded));
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) return null;
  const tries = [candidate, path.join(candidate, 'index.html'), candidate + '.html'];
  for (const file of tries) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** An http.Server serving `root` under `basePath` ('' or '/sub'). */
export function createStaticServer({ root, basePath = '' }) {
  const base = basePath.replace(/\/+$/, '');
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (base && url.pathname === '/') {
      res.writeHead(302, { Location: `${base}/` }).end();
      return;
    }
    let rel = url.pathname;
    if (base) {
      if (rel !== base && !rel.startsWith(base + '/')) rel = null;
      else rel = rel.slice(base.length) || '/';
    }
    const file = rel === null ? null : resolveFile(root, rel);
    const notFound = path.join(root, '404.html');
    const target = file ?? (fs.existsSync(notFound) ? notFound : null);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(file ? 200 : 404, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(target).pipe(res);
  });
}

function main() {
  const root = path.join(process.cwd(), 'out');
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    console.error('[preview] out/index.html missing — run `pnpm build` first');
    process.exit(1);
  }
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  const port = Number(process.env.PORT ?? 4173);
  const server = createStaticServer({ root, basePath });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[preview] serving out/ at http://localhost:${port}${basePath.replace(/\/+$/, '')}/ (Ctrl+C to stop)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
