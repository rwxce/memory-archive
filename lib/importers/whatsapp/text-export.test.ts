import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { chatLines, openChatZip } from './chat';
import { asImportArchive, isPlainTextExport } from './text-export';
import { ZipLimitError, readZipEntries, readZipEntryBytes } from './zip';

const text = (s: string) => new Blob([s], { type: 'text/plain' });

describe('isPlainTextExport', () => {
  test('is decided by content: text yes, ZIP signature, NUL bytes and empty no', async () => {
    expect(await isPlainTextExport(text('[17/03/2026, 13:17:05] Ana: hi'))).toBe(true);
    expect(await isPlainTextExport(new Blob([zipSync({ 'a.txt': strToU8('x') }) as BlobPart]))).toBe(false);
    expect(await isPlainTextExport(new Blob([new Uint8Array([0x50, 0x4b, 5, 6, 0, 0])]))).toBe(false);
    expect(await isPlainTextExport(new Blob([new Uint8Array([104, 105, 0, 106])]))).toBe(false);
    expect(await isPlainTextExport(new Blob([]))).toBe(false);
  });

  test('a ZIP is passed through untouched whatever its name, and text is wrapped', async () => {
    const zip = new Blob([zipSync({ '_chat.txt': strToU8('[17/03/2026, 13:17:05] Ana: hi') }) as BlobPart]);
    expect(await asImportArchive(zip, 1000)).toBe(zip);
    expect(await asImportArchive(text('hello'), 1000)).not.toBe(zip);
  });
});

describe('asImportArchive', () => {
  test('wraps text as a valid one-entry ZIP that reads back the same bytes and lines', async () => {
    const body = '[17/03/2026, 13:17:05] Ana: hola éñ\n[17/03/2026, 13:18:00] Bo: ok\n';
    const wrapped = await asImportArchive(text(body), 1000);
    const entries = await readZipEntries(wrapped);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: '_chat.txt', compression: 0, uncompressedSize: new TextEncoder().encode(body).length });
    expect(new TextDecoder().decode(await readZipEntryBytes(wrapped, entries[0]))).toBe(body);
    const lines: string[] = [];
    for await (const l of chatLines(wrapped, entries[0])) lines.push(l);
    expect(lines).toEqual(['[17/03/2026, 13:17:05] Ana: hola éñ', '[17/03/2026, 13:18:00] Bo: ok']);
  });

  test('the CRC matches the standard CRC-32', async () => {
    const [entry] = await readZipEntries(await asImportArchive(text('The quick brown fox jumps over the lazy dog'), 1000));
    expect(entry.crc32).toBe(0x414fa339);
  });

  test('the chat name comes from the file name, with a generic fallback', async () => {
    const wrapped = await asImportArchive(text('x'), 1000);
    expect((await openChatZip(wrapped, 'WhatsApp Chat with Ana.txt')).info).toEqual({ slug: 'whatsapp-chat-with-ana', name: 'WhatsApp Chat with Ana' });
    expect((await openChatZip(wrapped, '_chat.txt')).info).toEqual({ slug: 'chat', name: 'chat' });
    expect((await openChatZip(wrapped, '')).info).toEqual({ slug: 'chat', name: 'chat' });
  });

  test('text over the limit is refused', async () => {
    await expect(asImportArchive(text('x'.repeat(11)), 10)).rejects.toBeInstanceOf(ZipLimitError);
    await expect(asImportArchive(text('x'.repeat(10)), 10)).resolves.toBeInstanceOf(Blob);
  });
});
