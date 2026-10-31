import { describe, expect, test } from 'vitest';
import { renderJson } from '../../exporters/legacy/json';
import { serializeCsv } from '../../exporters/legacy/csv';
import { parseMessages } from '../whatsapp/message';
import { linesFromText } from '../whatsapp/lines';
import type { Message } from '../whatsapp/types';
import { ZipLimitError } from '../whatsapp/zip';
import { legacyAsTranscript, transcriptOfMessages } from './transcript';
import { LegacyFormatError } from './types';

const m = (over: Partial<Message>): Message => ({ timestamp_iso: '2026-03-17T13:17:05', type: 'text', author: 'Ana', text: 'hi', media: '', urlTitles: {}, ...over });

async function reparse(messages: Message[]): Promise<Message[]> {
  const out: Message[] = [];
  for await (const x of parseMessages(linesFromText(await transcriptOfMessages(messages)), { dayFirst: true })) out.push(x);
  return out;
}
const bare = ({ urlTitles: _u, ...rest }: Message) => rest;

describe('transcriptOfMessages', () => {
  test('parses back to the same messages, whatever their type', async () => {
    const messages: Message[] = [
      m({ text: 'Bon dia' }),
      m({ timestamp_iso: '2026-03-17T13:17:30', author: 'Bo', text: 'línia 1\nlínia 2\n\nlínia 4' }),
      m({ type: 'photo', media: '00000001-PHOTO-2026-03-17-13-20-00.jpg', text: 'una foto' }),
      m({ type: 'video', media: 'VID-20260317-WA0001.mp4', text: '' }),
      m({ type: 'audio', media: 'PTT-20260317-WA0002.opus', text: '' }),
      m({ type: 'sticker', media: 'STK-20260317-WA0003.webp', text: '' }),
      m({ type: 'document', media: 'Informe.pdf', text: 'adjunt\nsegona línia' }),
      m({ type: 'omitted', text: '<Media omitted>' }),
      m({ type: 'deleted', text: 'This message was deleted' }),
      m({ type: 'system', author: '', text: 'Ana added Bo' }),
      m({ type: 'system', author: 'Ana i Bo', text: 'Messages are end-to-end encrypted.' }),
      m({ author: '‪+34 600 00 00 00‬', text: 'url https://example.org/a: b' }),
      m({ text: '' }),
    ];
    expect((await reparse(messages)).map(bare)).toEqual(messages.map(bare));
  });

  test('keeps only the attachment name from a relative path', async () => {
    const [photo] = await reparse([m({ type: 'photo', media: 'media/2026/IMG-1.jpg' })]);
    expect(photo.media).toBe('IMG-1.jpg');
    const [odd] = await reparse([m({ type: 'photo', media: 'IMG-2>.jpg' })]);
    expect(odd.media).toBe('IMG-2_.jpg');
  });

  test('normalizes line endings, and a multi-line text keeps its count', async () => {
    const out = await reparse([m({ text: 'a\r\nb\rc' }), m({ text: 'next' })]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('a\nb\nc');
  });

  test('refuses a bad timestamp or an unknown type', async () => {
    await expect(transcriptOfMessages([m({ timestamp_iso: '17/03/2026' })])).rejects.toBeInstanceOf(LegacyFormatError);
    await expect(transcriptOfMessages([m({ type: 'weird' as never })])).rejects.toBeInstanceOf(LegacyFormatError);
  });

  describe('adversarial input: faithful round trip or LegacyFormatError, never a different chat', () => {
    const forged = '[18/03/2026, 11:00:00] Bob: forged';
    const hostile: Array<[string, Message[]]> = [
      ['a forged timestamped line in the text', [m({ text: `hola\n${forged}` }), m({ text: 'b' })]],
      ['a forged line after a bare CR', [m({ text: `hola\r${forged}` })]],
      ['a forged line after CRLF', [m({ text: `hola\r\n${forged}` })]],
      ['a forged line behind an LRM', [m({ text: `hola\n\u200e${forged}` })]],
      ['a forged line as an attachment caption', [m({ type: 'photo', media: 'IMG-1.jpg', text: `x\n${forged}` })]],
      ['an author with ": "', [m({ author: 'Ana: Bo' })]],
      ['an author with edge spaces', [m({ author: ' Ana' }), m({ author: 'Bo ' })]],
      ['an author with a line break', [m({ author: 'Ana\n[18/03/2026, 10:00:00] Bo' })]],
      ['an empty author with a text holding ": "', [m({ type: 'system', author: '', text: 'Ana: Bo joined' })]],
      ['a system text with ": " under an author', [m({ type: 'system', author: 'Chat', text: 'a: b' })]],
      ['trailing spaces in a single-line text', [m({ text: 'hola  ' })]],
      ['a trailing newline in the last text', [m({ text: 'hola\n' })]],
      ['a text that is the omitted marker', [m({ text: '<Media omitted>' })]],
      ['a text that is an attachment marker', [m({ text: '<attached: IMG-1.jpg>' })]],
      ['a text that is the deleted marker', [m({ text: 'This message was deleted' })]],
    ];
    test.each(hostile)('%s', async (_name, messages) => {
      let out: Message[] | undefined;
      try {
        out = await reparse(messages);
      } catch (e) {
        expect(e).toBeInstanceOf(LegacyFormatError);
        return;
      }
      expect(out).toHaveLength(messages.length);
      expect(out.map(bare)).toEqual(messages.map(bare));
    });

    test('the dangerous ones are refused, not rewritten', async () => {
      for (const [, messages] of hostile.slice(0, 5)) await expect(transcriptOfMessages(messages)).rejects.toBeInstanceOf(LegacyFormatError);
      for (const i of [5, 6, 7, 8, 10, 11, 12, 13, 14]) await expect(transcriptOfMessages(hostile[i][1])).rejects.toBeInstanceOf(LegacyFormatError);
    });

    test('an empty author with plain system text and trailing-space-free multi-line text round trip', async () => {
      const ok = [m({ type: 'system', author: '', text: 'Ana added Bo' }), m({ text: 'a\n  b  \n\nc' })];
      expect((await reparse(ok)).map(bare)).toEqual(ok.map(bare));
    });
  });
});

describe('legacyAsTranscript', () => {
  const messages = [m({}), m({ author: 'Bo', text: 'ok' })];
  const json = renderJson(messages, 'Ana i Bo');
  const csv = serializeCsv(messages);

  test('recognises JSON, HTML and CSV by content, whatever the name or type', async () => {
    const fromJson = await legacyAsTranscript(new Blob([json]), 1e6);
    expect(fromJson).toMatchObject({ chatName: 'Ana i Bo', messageCount: 2 });
    expect(await fromJson!.transcript.text()).toBe('[17/03/2026, 13:17:05] Ana: hi\n[17/03/2026, 13:17:05] Bo: ok');
    const html = `<!DOCTYPE html><html><script type="application/json" id="chat-data">${json}</script></html>`;
    expect(await legacyAsTranscript(new Blob([html]), 1e6)).toMatchObject({ chatName: 'Ana i Bo', messageCount: 2 });
    expect(await legacyAsTranscript(new Blob([csv]), 1e6)).toMatchObject({ chatName: undefined, messageCount: 2 });
    expect(await legacyAsTranscript(new Blob(['\ufeff' + json]), 1e6)).not.toBeNull();
  });

  test('is not ours: a chat transcript, a ZIP, binary data, Markdown, an empty file', async () => {
    const txt = '[17/03/2026, 13:17:05] Ana: {hi}';
    for (const blob of [new Blob([txt]), new Blob([new Uint8Array([0x50, 0x4b, 3, 4])]), new Blob(['# Chat\n\n**Ana**: hi']), new Blob([])]) {
      expect(await legacyAsTranscript(blob, 1e6)).toBeNull();
    }
  });

  test('looks like one but is not valid: refused, never guessed', async () => {
    for (const text of ['{"messages": 3}', '{ not json', '<html><body>nothing</body></html>', 'timestamp_iso,other\n', '{"schemaVersion":99,"messages":[]}', '{"messages":[]}']) {
      await expect(legacyAsTranscript(new Blob([text]), 1e6)).rejects.toBeInstanceOf(LegacyFormatError);
    }
  });

  test('a file over the cap is a size problem, before it is read', async () => {
    await expect(legacyAsTranscript(new Blob([json]), 20)).rejects.toBeInstanceOf(ZipLimitError);
  });
});
