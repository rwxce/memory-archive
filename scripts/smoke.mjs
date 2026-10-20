// Smoke test of the BUILT CLI (`dist/index.js`), not the sources: catches
// packaging bugs (files read at runtime that tsup does not ship, shebang,
// import.meta.url paths) that the source-level test suite cannot see.
//
//   pnpm build && pnpm smoke
//
// Runs the CLI on the synthetic fixture ZIP into a temp dir and checks the
// four outputs and the copied media.

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[smoke] OK: built CLI wrote 4 outputs and ${media.length} media file(s)`);
