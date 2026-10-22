// Fails when the UI message catalogs drift apart: every locale in
// `messages/` must have exactly the same keys, and every message must use the
// same ICU placeholders (`{version}`, `{count}`, ...) in every locale.
//
//   node scripts/check-i18n-parity.mjs
//
// Run by `pnpm check` (first step) and in CI.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Flatten `{a: {b: "x"}}` into `{"a.b": "x"}`. Non-string leaves are errors. */
export function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, id, out);
    } else if (typeof value === 'string') {
      out[id] = value;
    } else {
      throw new Error(`${id}: message must be a string`);
    }
  }
  return out;
}

/** Top-level ICU argument names used by a message, sorted. */
export function placeholders(message) {
  const names = new Set();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if (ch === "'") {
      // ICU quoting: '{' is literal; skip to the closing quote.
      const end = message.indexOf("'", i + 1);
      if (end > i + 1) i = end;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        const m = /^\{\s*([A-Za-z0-9_]+)/.exec(message.slice(i));
        if (m) names.add(m[1]);
      }
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return [...names].sort();
}

/**
 * Compare catalogs: `{ en: {...}, ca: {...} }`. Returns a list of problems
 * (empty when the catalogs are in parity).
 */
export function compareCatalogs(catalogs) {
  const problems = [];
  const flat = Object.fromEntries(
    Object.entries(catalogs).map(([locale, messages]) => [locale, flatten(messages)]),
  );
  const allKeys = new Set(Object.values(flat).flatMap((m) => Object.keys(m)));
  for (const key of [...allKeys].sort()) {
    const missing = Object.keys(flat).filter((locale) => !(key in flat[locale]));
    if (missing.length) {
      problems.push(`${key}: missing in ${missing.join(', ')}`);
      continue;
    }
    const shapes = Object.entries(flat).map(([locale, m]) => [locale, placeholders(m[key]).join(',')]);
    if (new Set(shapes.map(([, s]) => s)).size > 1) {
      problems.push(`${key}: placeholders differ (${shapes.map(([l, s]) => `${l}={${s}}`).join(' ')})`);
    }
    const empty = Object.entries(flat).filter(([, m]) => m[key].trim() === '').map(([l]) => l);
    if (empty.length) problems.push(`${key}: empty in ${empty.join(', ')}`);
  }
  return problems;
}

function main() {
  const dir = path.join(process.cwd(), 'messages');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const catalogs = Object.fromEntries(
    files.map((f) => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]),
  );
  for (const required of ['ca', 'en', 'es']) {
    if (!(required in catalogs)) {
      console.error(`[i18n] FAIL: messages/${required}.json is missing`);
      process.exit(1);
    }
  }
  const problems = compareCatalogs(catalogs);
  if (problems.length) {
    console.error(`[i18n] FAIL: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const count = Object.keys(flatten(catalogs.en)).length;
  console.log(`[i18n] OK: ${files.length} locales, ${count} keys each, placeholders match`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
