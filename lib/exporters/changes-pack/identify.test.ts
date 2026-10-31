import { describe, expect, test } from 'vitest';
import { zipSync } from 'fflate';
import { identifyArchiveFile } from './identify';
import { writeChangesPack } from './write';
import { syntheticSource } from './test-pack';

const zipWith = (files: Record<string, string>) =>
  new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])) as never) as BlobPart]);

describe('identifyArchiveFile', () => {
  test('a changes pack and a backup are told apart by the format name of the manifest', async () => {
    expect(await identifyArchiveFile((await writeChangesPack(syntheticSource())).blob)).toBe('changes-pack');
    expect(await identifyArchiveFile(zipWith({ 'manifest.json': '{"format":"memory-archive","formatVersion":1}' }))).toBe('backup');
  });

  test('anything else is unknown: no manifest, other format, not JSON, not an object', async () => {
    expect(await identifyArchiveFile(zipWith({ 'readme.txt': 'hi' }))).toBe('unknown');
    expect(await identifyArchiveFile(zipWith({ 'manifest.json': '{"format":"something-else"}' }))).toBe('unknown');
    expect(await identifyArchiveFile(zipWith({ 'manifest.json': 'not json' }))).toBe('unknown');
    expect(await identifyArchiveFile(zipWith({ 'manifest.json': 'null' }))).toBe('unknown');
  });

  test('a file that is not a ZIP, or a manifest above the limit, is refused', async () => {
    await expect(identifyArchiveFile(new Blob(['plain text']))).rejects.toMatchObject({ code: 'not-an-archive' });
    await expect(identifyArchiveFile(zipWith({ 'manifest.json': '{"format":"memory-archive"}' }), { maxManifestBytes: 5 })).rejects.toMatchObject({ code: 'limit-exceeded' });
  });
});
