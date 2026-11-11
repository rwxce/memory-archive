// Smoke test of the BUILT artifacts, not the sources:
//
// 1. The CLI (`dist/index.js`): catches packaging bugs (files read at runtime
//    that tsup does not ship, shebang, import.meta.url paths) that the
//    source-level test suite cannot see. Runs the CLI on the synthetic fixture
//    ZIP into a temp dir and checks the four outputs and the copied media.
// 2. The app's static export (`out/`): every locale page exists with the right
//    `lang`, and no page or stylesheet loads anything from another origin.
//
//   pnpm build && pnpm smoke

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'dist', 'index.js');
const ZIP = path.join(ROOT, 'fixtures', 'WhatsApp Chat - Notas pessoais.zip');

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(CLI)) fail(`${path.relative(ROOT, CLI)} missing — run pnpm build first`);
if (!fs.existsSync(ZIP)) {
  const gen = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-fixtures.mjs')], {
    stdio: 'inherit',
  });
  if (gen.status !== 0) fail('fixture generation failed');
}

// Run from a temp cwd so nothing resolves relative to the repo checkout.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-smoke-'));
const out = path.join(tmp, 'out');
const run = spawnSync(process.execPath, [CLI, ZIP, '--out', out], { cwd: tmp, encoding: 'utf8' });
if (run.status !== 0) fail(`CLI exited with ${run.status}\n${run.stdout}\n${run.stderr}`);

const dir = path.join(out, 'notas-pessoais');
for (const f of ['messages.csv', 'messages.json', 'messages.md', 'messages.html']) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) fail(`missing or empty ${f}`);
}
const media = fs.existsSync(path.join(dir, 'media')) ? fs.readdirSync(path.join(dir, 'media')) : [];
if (media.length === 0) fail('no media copied');

const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
if (!html.includes('function populateTranscript')) fail('viewer script not inlined in messages.html');
if (/\bimport\s[^;]*from\s*['"]\.\//.test(html)) fail('messages.html still has relative module imports');
const json = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
if (!Array.isArray(json.messages) || json.messages.length === 0) fail('messages.json has no messages');

if (json.schemaVersion !== 1 || json.generator?.name !== 'memory-archive') {
  fail('messages.json lacks schemaVersion 1 / generator');
}

// Round trip through the built CLI: rebuild the CSV from the HTML island.
const csv = fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8');
fs.rmSync(path.join(dir, 'messages.csv'));
const legacy = spawnSync(process.execPath, [CLI, 'import-legacy', path.join(dir, 'messages.html')], {
  cwd: tmp,
  encoding: 'utf8',
});
if (legacy.status !== 0) fail(`import-legacy exited with ${legacy.status}\n${legacy.stderr}`);
if (fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8') !== csv) {
  fail('import-legacy from messages.html did not rebuild an identical messages.csv');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `[smoke] OK: built CLI wrote 4 outputs and ${media.length} media file(s); import-legacy round trip identical`,
);

// ---- 2. static export ----
const OUT = path.join(ROOT, 'out');
const LOCALES = ['en', 'ca', 'es'];
const pages = [
  'index.html',
  '404.html',
  ...LOCALES.flatMap((l) => [`${l}/index.html`, `${l}/settings/index.html`, `${l}/import/index.html`, `${l}/import/history/index.html`, `${l}/backup/index.html`, `${l}/offline/index.html`]),
];
for (const page of pages) {
  if (!fs.existsSync(path.join(OUT, page))) fail(`out/${page} missing — did next build run?`);
}
for (const l of LOCALES) {
  const page = fs.readFileSync(path.join(OUT, l, 'index.html'), 'utf8');
  if (!page.includes(`<html lang="${l}"`)) fail(`out/${l}/index.html is not lang="${l}"`);
}

// Link previews: every shareable entry page points og:image at its own locale's
// card, and the card ships in out/og/.
for (const [page, l] of [['index.html', 'en'], ...LOCALES.map((l) => [`${l}/index.html`, l])]) {
  const html = fs.readFileSync(path.join(OUT, page), 'utf8');
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (!m) fail(`out/${page} has no og:image`);
  if (!/^https?:\/\//.test(m[1])) fail(`out/${page} og:image is not absolute: ${m[1]}`);
  if (!m[1].includes(`/og/${l}.png`)) fail(`out/${page} og:image is not the ${l} card: ${m[1]}`);
  if (!html.includes('name="twitter:card" content="summary_large_image"')) fail(`out/${page} has no large twitter card`);
  if (!fs.existsSync(path.join(OUT, 'og', `${l}.png`))) fail(`out/og/${l}.png missing`);
}

/** Remote resources a page or stylesheet would load by itself. */
function remoteResources(text) {
  const found = [];
  const attr = /\b(?:src|srcset|poster)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi;
  const link = /<link\b[^>]*\bhref\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi;
  const css = /(?:url\(\s*["']?|@import\s+["'])\s*((?:https?:)?\/\/[^"')\s]+)/gi;
  for (const re of [attr, link, css]) for (const m of text.matchAll(re)) found.push(m[1]);
  // SVG namespaces are identifiers, not requests.
  return found.filter((u) => !/^https?:\/\/www\.w3\.org\//.test(u));
}

let scanned = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(html|css)$/.test(entry.name)) {
      const remote = remoteResources(fs.readFileSync(p, 'utf8'));
      if (remote.length) fail(`${path.relative(ROOT, p)} loads remote resources: ${remote.join(', ')}`);
      scanned++;
    }
  }
};
walk(OUT);

// PWA: manifest with icons + share target, and a service worker that
// precaches every page (so the app opens in airplane mode).
const manifestPath = path.join(OUT, 'manifest.webmanifest');
if (!fs.existsSync(manifestPath)) fail('out/manifest.webmanifest missing');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const icon of manifest.icons ?? []) {
  const rel = icon.src.replace(/^.*?\/icons\//, 'icons/');
  if (!fs.existsSync(path.join(OUT, rel))) fail(`manifest icon ${icon.src} missing from out/`);
}
if (!manifest.icons?.some((i) => i.purpose === 'maskable')) fail('manifest has no maskable icon');
if (manifest.share_target?.method !== 'POST' || !manifest.share_target?.params?.files) {
  fail('manifest share_target (POST with files) missing');
}
const swPath = path.join(OUT, 'sw.js');
if (!fs.existsSync(swPath)) fail('out/sw.js missing — did scripts/build-sw.mjs run?');
const sw = fs.readFileSync(swPath, 'utf8');
if (sw.includes('self.__SW_MANIFEST')) fail('out/sw.js still has the un-injected precache manifest');
for (const page of pages) {
  if (!sw.includes(JSON.stringify(page))) fail(`out/sw.js does not precache ${page}`);
}
if (sw.includes('"og/')) fail('out/sw.js precaches the share cards (og/), which the app never shows');

// Database and import: the worker bundles and the SQLite binary ship in out/db/ and are
// precached, so the library opens offline.
for (const f of ['db/worker.js', 'db/sqlite3.wasm', 'db/import-worker.js']) {
  if (!fs.existsSync(path.join(OUT, f)) || fs.statSync(path.join(OUT, f)).size === 0) fail(`out/${f} missing or empty`);
  if (!sw.includes(JSON.stringify(f))) fail(`out/sw.js does not precache ${f}`);
}
console.log(
  `[smoke] OK: static export has ${pages.length} pages; ${scanned} HTML/CSS files load nothing remote; manifest + sw.js precache every page`,
);

// Standalone viewer: one self-contained template (style and script inlined) with the data island
// placeholder, shipped in out/viewer/ and precached; the remote-resource scan above covered it.
{
  const viewer = path.join(OUT, 'viewer', 'viewer-template.html');
  if (!fs.existsSync(viewer)) fail('out/viewer/viewer-template.html missing — did scripts/build-viewer.mjs run?');
  const text = fs.readFileSync(viewer, 'utf8');
  const island = '<script type="application/json" id="viewer-data">__VIEWER_DATA__</script>';
  if (text.split(island).length !== 2) fail('viewer template must have exactly one data island placeholder');
  if (/__VIEWER_(STYLE|SCRIPT)__/.test(text)) fail('viewer template still has an un-injected style/script placeholder');
  if (/<link\b|<script\b[^>]*\bsrc=/i.test(text)) fail('viewer template must not load external files');
  if (!sw.includes(JSON.stringify('viewer/viewer-template.html'))) fail('out/sw.js does not precache the viewer template');
  console.log(`[smoke] OK: viewer template is one self-contained file (${(text.length / 1024).toFixed(0)} KB) with a data island`);
}
