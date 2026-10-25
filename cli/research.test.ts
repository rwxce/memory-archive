import { describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { FORMAT_FIXTURES } from '../scripts/generate-fixtures.mjs';
import { createMessageDrafter } from '@/lib/usecases/import';
import { parseWhatsAppZip } from '@/lib/importers/whatsapp';
import { buildCli } from './main';
import { checkFindings, exportForResearch } from './research';
import { openZip } from './zip';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ma-research-'));
}

function syntheticZip(dir: string): string {
  const f = FORMAT_FIXTURES[0]!;
  const zipPath = path.join(dir, f.zip);
  fs.writeFileSync(zipPath, zipSync({ '_chat.txt': strToU8(f.txt) }));
  return zipPath;
}

describe('export-for-research', () => {
  test('writes one row per message with the same fingerprints the app import computes', async () => {
    const dir = tmp();
    const zipPath = syntheticZip(dir);
    const res = await exportForResearch(zipPath, path.join(dir, 'out'));
    const rows = fs.readFileSync(res.file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));

    const { messages } = await parseWhatsAppZip(await openZip(zipPath), path.basename(zipPath));
    const draft = createMessageDrafter();
    expect(rows).toHaveLength(messages.length);
    expect(res.messageCount).toBe(messages.length);
    expect(rows.map((r) => r.fingerprint)).toEqual(messages.map((m) => draft(m).fingerprint));
    expect(Object.keys(rows[0]).sort()).toEqual(['author', 'fingerprint', 'text', 'ts']);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(rows.length);

    const meta = JSON.parse(fs.readFileSync(res.metaFile, 'utf8'));
    expect(meta).toEqual({ name: expect.any(String), messageCount: rows.length, firstFingerprint: rows[0].fingerprint });
  });

  test('the CLI command warns about the LLM privacy risk', async () => {
    const dir = tmp();
    const zipPath = syntheticZip(dir);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await buildCli().parseAsync(['node', 'x', 'export-for-research', zipPath, '--out', path.join(dir, 'o')]);
      expect(err.mock.calls.flat().join('\n')).toContain('leaves this device');
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});

describe('check-findings', () => {
  function write(dir: string, value: unknown): string {
    const file = path.join(dir, 'findings.json');
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  }
  const good = {
    version: 1,
    conversation: { name: 'Example', messageCount: 1 },
    highlights: [
      { id: 'a', category: 'interest', title: 't', summary: '', messages: ['0'.repeat(64)], createdBy: 'me', createdAt: '2026-01-01T00:00:00Z' },
    ],
  };

  test('accepts a valid file and reports typed errors for a bad one', async () => {
    const dir = tmp();
    expect(await checkFindings(write(dir, good))).toMatchObject({ ok: true, highlights: 1 });
    const bad = await checkFindings(write(dir, { ...good, highlights: [{ ...good.highlights[0], category: 'x' }] }));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatchObject({ code: 'invalid-category', path: 'highlights[0].category' });
    expect((await checkFindings(write(dir, '{nope'))).ok).toBe(false);
  });

  test('sets a failing exit code through the command', async () => {
    const dir = tmp();
    const file = write(dir, { version: 9 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.exitCode;
    try {
      await buildCli().parseAsync(['node', 'x', 'check-findings', file]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      err.mockRestore();
    }
  });
});
