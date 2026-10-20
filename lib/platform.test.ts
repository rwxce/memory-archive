/**
 * `lib/` must run unchanged in the browser (Phase 2 runs the importer inside
 * a Web Worker). ESLint forbids Node imports there (`no-restricted-imports`);
 * this suite double-checks the source and runs the importer with Node-only
 * globals removed.
 */
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinModules } from 'node:module';
import { strToU8, zipSync } from 'fflate';

const LIB = path.join(process.cwd(), 'lib');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('lib/ is platform-neutral', () => {
  const files = sourceFiles(LIB);

  test('there are sources to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files.map((f) => [path.relative(process.cwd(), f), f]))(
    '%s imports no Node built-ins and uses no Node globals',
    (_rel, file) => {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3];
        expect(NODE_BUILTINS.has(spec.split('/')[0]) || spec.startsWith('node:'), spec).toBe(false);
      }
      // Strip comments before looking for Node-only globals.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bBuffer\.|\bprocess\.|\b__dirname\b|\b__filename\b|\brequire\(/);
    },
  );

  test('the importer runs with Node-only globals removed, fed by web streams', async () => {
    const { parseWhatsAppZip } = await import('./importers/whatsapp');
    const { renderHtml, renderJson, renderMarkdown, serializeCsv } = await import('./exporters/legacy');
    const zip = new Blob([
      zipSync({
        'WhatsApp Chat - Web/_chat.txt': strToU8(
          '[01/02/2026 10:00:00] Ana: olá\n[01/02/2026 10:01:00] Bo: <attached: IMG-1.jpg>\n',
        ),
        'WhatsApp Chat - Web/IMG-1.jpg': new Uint8Array([1, 2, 3]),
      }),
    ]);
    const g = globalThis as Record<string, unknown>;
    const saved = { Buffer: g.Buffer, setImmediate: g.setImmediate };
    delete g.Buffer;
    delete g.setImmediate;
    try {
      const { info, messages } = await parseWhatsAppZip(zip, 'export.zip');
      expect(info.name).toBe('Web');
      expect(messages.map((m) => m.type)).toEqual(['text', 'photo']);
      expect(serializeCsv(messages)).toContain('olá');
      expect(renderJson(messages, info.name)).toContain('"chatName":"Web"');
      expect(await renderMarkdown(messages, info.name)).toContain('# Web');
      expect(await renderHtml(messages, info.name)).toContain('<!DOCTYPE html>');
    } finally {
      Object.assign(g, saved);
    }
  });
});
