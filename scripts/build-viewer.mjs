// Builds the standalone viewer (viewer/) into ONE self-contained HTML template:
//
//   viewer/template.html   shell with the style, the script and the data island placeholders
//   viewer/viewer.css      inlined into <style>
//   viewer/src/main.ts     bundled by esbuild into one minified classic script, inlined
//
//   -> public/viewer/viewer-template.html (git-ignored; `next build` copies it to out/viewer/)
//
// The template still holds the data placeholder: `renderViewerHtml` (lib/exporters/viewer/html.ts)
// injects the serialized viewer data at export time. Nothing is committed: the template is
// generated on every `pnpm build`, like public/db/.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const VIEWER_OUT_DIR = path.join('public', 'viewer');
export const VIEWER_TEMPLATE_FILE = 'viewer-template.html';

const STYLE = '__VIEWER_STYLE__';
const SCRIPT = '__VIEWER_SCRIPT__';

/** Text that is safe inside <style> / <script>: no closing tag can occur. */
const inertScript = (code) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const inertStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

export async function buildViewerTemplate({ root = process.cwd() } = {}) {
  const dir = path.join(root, 'viewer');
  const shell = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'viewer.css'), 'utf8');
  const result = await build({
    entryPoints: [path.join(dir, 'src', 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning',
  });
  const code = result.outputFiles[0].text;
  for (const token of [STYLE, SCRIPT]) {
    if (shell.split(token).length !== 2) throw new Error(`viewer/template.html must contain ${token} exactly once`);
  }
  // Function replacers: the CSS and the script contain `$` sequences.
  return shell.replace(STYLE, () => inertStyle(css.trim())).replace(SCRIPT, () => inertScript(code.trim()));
}

async function main() {
  const root = process.cwd();
  const html = await buildViewerTemplate({ root });
  const outDir = path.join(root, VIEWER_OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, VIEWER_TEMPLATE_FILE), html);
  console.log('[build-viewer] wrote', path.join(VIEWER_OUT_DIR, VIEWER_TEMPLATE_FILE), `(${(html.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
