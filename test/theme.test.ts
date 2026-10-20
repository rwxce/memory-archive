import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const NOTAS = 'WhatsApp Chat - Notas pessoais';

test('html: theme toggle handled by a classic (non-module) script', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-theme-'));
  await runParser(path.join(ROOT, 'fixtures', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  assert.ok(html.includes('id="theme-toggle"'), 'toggle button present');
  assert.ok(html.includes('data-theme="light"'), 'default theme set');

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const theme = scripts.find(
    (s) => s[1].trim() === '' && s[2].includes("getElementById('theme-toggle')"),
  );
  assert.ok(theme, 'classic theme script found');
  assert.ok(!/type="module"/.test(theme[1]), 'theme script is NOT a module');
  assert.ok(html.includes('.lightbox'), 'existing lightbox unaffected');
});

test('transcript.js: theme toggle not double-bound in the module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/js/transcript.js'), 'utf8');
  assert.ok(
    !/toggle\?\.addEventListener/.test(src),
    'module does not bind theme-toggle (classic script owns it)',
  );
});

test('html: link color is theme-aware (visible in dark mode)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-linkclr-'));
  await runParser(path.join(ROOT, 'fixtures', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  assert.ok(html.includes('--link:#0b93f6'), 'light link color token');
  assert.ok(html.includes('--link:#58a6ff'), 'dark link color token');
  assert.ok(html.includes('a { color:var(--link)'), 'anchors use the link token');
});

test('html: text/sender filter works from file:// (classic, non-module script)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-filter-'));
  await runParser(path.join(ROOT, 'fixtures', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  // Server rows carry data-author so the sender filter can match offline.
  assert.ok(/class="bubble-row [^"]*" data-author="/.test(html), 'bubble rows carry data-author');

  // Filter logic lives in a classic (non-module) script so it runs under file://.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const filter = scripts.find(
    (s) => s[1].trim() === '' && s[2].includes("getElementById('search')") && s[2].includes('applyFilter'),
  );
  assert.ok(filter, 'classic filter script found');
  assert.ok(!/type="module"/.test(filter[1]), 'filter script is NOT a module');
});

test('transcript.js: search/sender no longer double-bound in the module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/js/transcript.js'), 'utf8');
  assert.ok(!/wireControls/.test(src), 'module no longer wires search/sender (classic script owns it)');
});

test('html: long text/URLs wrap inside the bubble border (no overflow)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wrap-'));
  await runParser(path.join(ROOT, 'fixtures', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  assert.ok(/\.bubble\s*\{[^}]*overflow-wrap:\s*anywhere/.test(html), 'bubble uses overflow-wrap:anywhere');
  assert.ok(/\.bubble\s*\{[^}]*min-width:\s*0/.test(html), 'bubble allows shrink (min-width:0)');
});
