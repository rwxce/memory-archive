/**
 * Round-trips through the real CLI: fixture ZIP -> outputs -> delete the CSV
 * -> `import-legacy` from messages.json / messages.html -> identical CSV.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCli } from './main';
import { runParser } from './pipeline';

const FIXTURES = path.join(process.cwd(), 'fixtures');

async function cli(...args: string[]): Promise<number> {
  process.exitCode = 0;
  await buildCli().exitOverride().parseAsync(['node', 'memory-archive', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ['WhatsApp Chat - Notas pessoais.zip', 'notas-pessoais'],
  ['WhatsApp Chat - Android US.zip', 'android-us'],
  ['WhatsApp Chat - iOS US.zip', 'ios-us'],
])('round trip of %s', (zip, slug) => {
  async function setup() {
    const out = tmp('ma-legacy-');
    await runParser(path.join(FIXTURES, zip), { out });
    const dir = path.join(out, slug);
    return { out, dir, csv: fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8') };
  }

  test.each(['messages.json', 'messages.html'])('import-legacy %s rebuilds an identical CSV in place', async (file) => {
    const { dir, csv } = await setup();
    fs.rmSync(path.join(dir, 'messages.csv'));
    fs.rmSync(path.join(dir, 'messages.md'));
    expect(await cli('import-legacy', path.join(dir, file))).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8')).toBe(csv);
    expect(fs.existsSync(path.join(dir, 'messages.md'))).toBe(true);
    // Idempotent: a second import adds nothing.
    expect(await cli('import-legacy', path.join(dir, file))).toBe(0);
    expect(logs.join('\n')).toMatch(/, 0 new/);
    expect(fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8')).toBe(csv);
  });

  test('import-legacy --out writes a new folder, copies the media and keeps the CSV identical', async () => {
    const { dir, csv } = await setup();
    const other = tmp('ma-legacy-out-');
    expect(await cli('import-legacy', path.join(dir, 'messages.html'), '--out', other)).toBe(0);
    const dest = path.join(other, slug);
    expect(fs.readFileSync(path.join(dest, 'messages.csv'), 'utf8')).toBe(csv);
    const media = (d: string) => (fs.existsSync(path.join(d, 'media')) ? fs.readdirSync(path.join(d, 'media')).sort() : []);
    const referenced = new Set(
      JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8')).messages.map((m: { media: string }) => m.media),
    );
    expect(media(dest)).toEqual(media(dir).filter((f) => referenced.has(f)));
    // The re-rendered JSON points at the copied media.
    const env = JSON.parse(fs.readFileSync(path.join(dest, 'messages.json'), 'utf8'));
    for (const m of env.messages) if (m.mediaPath) expect(fs.existsSync(path.join(dest, m.mediaPath))).toBe(true);
  });

  test('render <dir> re-renders the outputs from the CSV, keeping the chat name', async () => {
    const { dir } = await setup();
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    fs.rmSync(path.join(dir, 'messages.html'));
    fs.rmSync(path.join(dir, 'messages.md'));
    expect(await cli('render', dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'messages.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'messages.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'))).toEqual(before);
  });
});

describe('legacy inputs', () => {
  test('a schema-0 messages.json (old wa-backup, no schemaVersion) imports', async () => {
    const out = tmp('ma-legacy-v0-');
    await runParser(path.join(FIXTURES, 'WhatsApp Chat - Notas pessoais.zip'), { out });
    const dir = path.join(out, 'notas-pessoais');
    const csv = fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8');
    const env = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    delete env.schemaVersion;
    delete env.generator;
    const old = tmp('ma-legacy-v0-src-');
    fs.writeFileSync(path.join(old, 'messages.json'), JSON.stringify(env));
    fs.rmSync(path.join(dir, 'messages.csv'));
    expect(await cli('import-legacy', path.join(old, 'messages.json'), '--out', out)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'messages.csv'), 'utf8')).toBe(csv);
  });

  test('Markdown is refused with a clear error and exit code 1', async () => {
    const dir = tmp('ma-legacy-md-');
    fs.writeFileSync(path.join(dir, 'messages.md'), '# Chat\n');
    expect(await cli('import-legacy', path.join(dir, 'messages.md'))).toBe(1);
    expect(logs.join('\n')).toMatch(/lossy/);
    expect(fs.existsSync(path.join(dir, 'messages.csv'))).toBe(false);
  });

  test('render without messages.csv fails with exit code 1', async () => {
    expect(await cli('render', tmp('ma-legacy-empty-'))).toBe(1);
    expect(logs.join('\n')).toMatch(/no messages.csv/);
  });

  test('a CSV without a chat name takes --name', async () => {
    const dir = tmp('ma-legacy-csv-');
    fs.writeFileSync(
      path.join(dir, 'old.csv'),
      'timestamp_iso,type,author,text,media\n2025-01-01T08:00:00,text,Ana,hi,\n',
    );
    const out = tmp('ma-legacy-csv-out-');
    expect(await cli('import-legacy', path.join(dir, 'old.csv'), '--out', out, '--name', 'Old Chat')).toBe(0);
    const env = JSON.parse(fs.readFileSync(path.join(out, 'old-chat', 'messages.json'), 'utf8'));
    expect(env.metadata.chatName).toBe('Old Chat');
    expect(env.messages).toHaveLength(1);
  });
});
