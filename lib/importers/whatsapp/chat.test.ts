import { describe, expect, test } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  chatInfoFromEntryNames,
  chatLines,
  findChatEntry,
  isAppleDouble,
  openChatZip,
  slugifyChatName,
} from './chat';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('chat entry helpers', () => {
  test('slugifyChatName strips the prefix, diacritics and punctuation', () => {
    expect(slugifyChatName('WhatsApp Chat - Plataforma WK')).toBe('plataforma-wk');
    expect(slugifyChatName('WhatsApp Chat - Ação & Café!')).toBe('acao-cafe');
  });

  test('AppleDouble companions are never the transcript', () => {
    expect(isAppleDouble('__MACOSX/x/._chat.txt')).toBe(true);
    expect(isAppleDouble('chat/._IMG.jpg')).toBe(true);
    expect(isAppleDouble('chat/_chat.txt')).toBe(false);
    expect(
      findChatEntry([{ name: '__MACOSX/c/._chat.txt' }, { name: 'c/_chat.txt' }])?.name,
    ).toBe('c/_chat.txt');
  });

  test('name comes from the folder, or from the ZIP file name at the root', () => {
    expect(chatInfoFromEntryNames(['WhatsApp Chat - Ana/_chat.txt'], 'x.zip')).toEqual({
      slug: 'ana',
      name: 'Ana',
    });
    expect(chatInfoFromEntryNames(['_chat.txt'], 'WhatsApp Chat - Root Level.zip')).toEqual({
      slug: 'root-level',
      name: 'Root Level',
    });
    // A path is reduced to its base name.
    expect(chatInfoFromEntryNames(['_chat.txt'], '/tmp/dir/WhatsApp Chat - Bo.zip').slug).toBe('bo');
    // Nothing usable -> "chat".
    expect(chatInfoFromEntryNames(['_chat.txt'], '!!!.zip').slug).toBe('chat');
  });

  test('missing transcript throws', () => {
    expect(() => chatInfoFromEntryNames(['a.jpg'], 'x.zip')).toThrow('No _chat.txt entry found in ZIP');
  });

  test('openChatZip + chatLines stream the transcript from a Blob', async () => {
    const zip = new Blob([
      zipSync({
        'WhatsApp Chat - Ana/IMG-1.jpg': new Uint8Array([1]),
        'WhatsApp Chat - Ana/_chat.txt': strToU8('[01/01/2026 10:00:00] Ana: oi\nsegunda linha\n'),
      }),
    ]);
    const { chatEntry, info, entries } = await openChatZip(zip, 'x.zip');
    expect(info.name).toBe('Ana');
    expect(entries).toHaveLength(2);
    expect(await collect(chatLines(zip, chatEntry))).toEqual([
      '[01/01/2026 10:00:00] Ana: oi',
      'segunda linha',
    ]);
  });

  test('openChatZip rejects archives without a transcript', async () => {
    const zip = new Blob([zipSync({ 'a.jpg': new Uint8Array([1]) })]);
    await expect(openChatZip(zip, 'x.zip')).rejects.toThrow('No _chat.txt entry found in ZIP');
  });
});
