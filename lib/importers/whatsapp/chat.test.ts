import { describe, expect, test } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  chatInfoFromEntryNames,
  chatKeyOf,
  chatTitleOf,
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

describe('chat title and key', () => {
  test('every language prefix gives the same title and key', () => {
    for (const name of [
      'WhatsApp Chat - Dana Example',
      'WhatsApp Chat with Dana Example',
      'Chat de WhatsApp con Dana Example',
      'Conversa do WhatsApp com Dana Example',
      'Xat de WhatsApp amb Dana Example',
      '00000068-Conversa do WhatsApp com Dana Example',
      'Dana Example',
    ]) {
      expect(chatTitleOf(name)).toBe('Dana Example');
      expect(chatKeyOf(name)).toBe('dana example');
    }
  });

  test('case, spacing, composition and invisible marks do not change the key; other names do', () => {
    expect(chatKeyOf('WhatsApp Chat - \u200eMar\u00eda  PAU')).toBe(chatKeyOf('Chat de WhatsApp con Mari\u0301a pau'));
    expect(chatKeyOf('Maria')).not.toBe(chatKeyOf('Mario'));
  });

  test('never empty', () => {
    expect(chatTitleOf('WhatsApp Chat - ')).toBeTruthy();
    expect(chatKeyOf('')).toBe('chat');
  });
});

describe('chat entry helpers', () => {
  test('slugifyChatName strips the prefix, diacritics and punctuation', () => {
    expect(slugifyChatName('WhatsApp Chat - Example Org')).toBe('example-org');
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

describe('openChatZip limits', () => {
  test('refuses a transcript larger than maxChatBytes and a ZIP with too many entries', async () => {
    const zip = new Blob([zipSync({ '_chat.txt': strToU8('x'.repeat(100)), 'a.jpg': strToU8('1') }) as BlobPart]);
    await expect(openChatZip(zip, 'x.zip', { maxChatBytes: 50 })).rejects.toMatchObject({ name: 'ZipLimitError' });
    await expect(openChatZip(zip, 'x.zip', { maxEntries: 1 })).rejects.toMatchObject({ name: 'ZipLimitError' });
    await expect(openChatZip(zip, 'x.zip', { maxChatBytes: 100, maxEntries: 2 })).resolves.toBeDefined();
  });
});
