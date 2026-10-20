import { describe, expect, test } from 'vitest';
import { linesFromText } from './lines';
import { classifyType, parseMessages } from './message';
import type { Message } from './types';

async function parse(text: string): Promise<Message[]> {
  const out: Message[] = [];
  for await (const m of parseMessages(linesFromText(text))) out.push(m);
  return out;
}

describe('classifyType', () => {
  test('attachment filename decides the media type', () => {
    expect(classifyType('', 'IMG-1.jpg', true)).toBe('photo');
    expect(classifyType('', 'VIDEO-1.mp4', true)).toBe('video');
    expect(classifyType('', 'STICKER-1.webp', true)).toBe('sticker');
    expect(classifyType('', 'report.pdf', true)).toBe('document');
  });

  test('markers and missing sender', () => {
    expect(classifyType('image omitted', null, true)).toBe('omitted');
    expect(classifyType('<Media omitted>', null, true)).toBe('omitted');
    expect(classifyType('This message was deleted', null, true)).toBe('deleted');
    expect(classifyType('Ana created group "X"', null, false)).toBe('system');
    expect(classifyType('hello', null, true)).toBe('text');
  });
});

describe('parseMessages', () => {
  test('continuation lines join the open message', async () => {
    const msgs = await parse('[01/02/2026 10:00:00] Ana: one\ntwo\n[01/02/2026 10:01:00] Bo: three');
    expect(msgs.map((m) => [m.author, m.text])).toEqual([
      ['Ana', 'one\ntwo'],
      ['Bo', 'three'],
    ]);
    expect(msgs[0].timestamp_iso).toBe('2026-02-01T10:00:00');
  });

  test('empty body + same-author attachment merge into one media row', async () => {
    const msgs = await parse(
      '[01/02/2026 10:00:00] Ana:\n[01/02/2026 10:00:01] Ana: <attached: IMG-1.jpg>',
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'photo', media: 'IMG-1.jpg', text: '' });
  });

  test('a line before the first timestamp is dropped (no open message)', async () => {
    const msgs = await parse('preamble\n[01/02/2026 10:00:00] Ana: hi');
    expect(msgs.map((m) => m.text)).toEqual(['hi']);
  });
});

describe('format coverage (PR 3 fixes)', () => {
  test('Android system line drops the " - " separator', async () => {
    const [m] = await parse('31/12/2025, 23:59 - Ana created group "X"');
    expect(m).toMatchObject({ type: 'system', author: '', text: 'Ana created group "X"' });
  });

  test('iOS system line: chat-name sender + U+200E body', async () => {
    const [m] = await parse('[31/12/2025, 23:59:00] Family: ‎Ana added Bo');
    expect(m).toMatchObject({ type: 'system', author: 'Family', text: 'Ana added Bo' });
  });

  test('a U+200E inside (not leading) a body stays text', async () => {
    const [m] = await parse('[31/12/2025, 23:59:00] Ana: see ‎page 1');
    expect(m.type).toBe('text');
  });

  test.each([
    ['IMG-20260101-WA0001.jpg (file attached)', 'photo', 'IMG-20260101-WA0001.jpg'],
    ['VID-20260101-WA0002.mp4 (archivo adjunto)', 'video', 'VID-20260101-WA0002.mp4'],
    ['STK-20260101-WA0003.webp (arquivo anexado)', 'sticker', 'STK-20260101-WA0003.webp'],
    ['DOC-20260101-WA0004.pdf (fitxer adjunt)', 'document', 'DOC-20260101-WA0004.pdf'],
    ['My Report 2026.pdf (file attached)', 'document', 'My Report 2026.pdf'],
    ['<adjunto: 00000001-PHOTO-2026-01-01-10-00-00.jpg>', 'photo', '00000001-PHOTO-2026-01-01-10-00-00.jpg'],
    ['<anexado: 00000002-VIDEO-2026-01-01-10-00-00.mp4>', 'video', '00000002-VIDEO-2026-01-01-10-00-00.mp4'],
    ['<adjunt: 00000003-AUDIO-2026-01-01-10-00-00.opus>', 'audio', '00000003-AUDIO-2026-01-01-10-00-00.opus'],
    ['<attached: holiday.heic>', 'photo', 'holiday.heic'],
    ['<attached: clip.mov>', 'video', 'clip.mov'],
  ])('attachment %s -> %s', async (body, type, media) => {
    const [m] = await parse(`31/12/2025, 23:59 - Ana: ${body}`);
    expect(m).toMatchObject({ type, media, text: '' });
  });

  test('Android caption on the following line joins the media row', async () => {
    const [m] = await parse('31/12/2025, 23:59 - Ana: IMG-1.jpg (file attached)\nnice view');
    expect(m).toMatchObject({ type: 'photo', media: 'IMG-1.jpg', text: 'nice view' });
  });

  test('"(file attached)" mid-sentence is not an attachment', async () => {
    const [m] = await parse('31/12/2025, 23:59 - Ana: see notes.txt (file attached) later');
    // Android writes the marker as the whole first line; text after it is a sentence.
    expect(m.media).toBe('');
    expect(m.type).toBe('text');
  });

  test.each([
    '<Media omitted>',
    '<Mídia oculta>',
    '<Multimedia omitido>',
    '<Multimèdia omès>',
    'imagen omitida',
    'imagem ocultada',
    'vídeo omitido',
    'áudio ocultado',
    'figurinha omitida',
    'GIF omitted',
  ])('omitted placeholder %s', (body) => {
    expect(classifyType(body, null, true)).toBe('omitted');
  });

  test.each([
    'This message was deleted',
    'You deleted this message',
    'Mensagem apagada',
    'Você apagou esta mensagem',
    'Se eliminó este mensaje.',
    'Eliminaste este mensaje.',
    "S'ha suprimit aquest missatge.",
    'S’ha suprimit aquest missatge.',
    'Has suprimit aquest missatge.',
  ])('deleted marker %s', (body) => {
    expect(classifyType(body, null, true)).toBe('deleted');
  });

  test('identical messages in the same minute stay two rows', async () => {
    const msgs = await parse('1/1/26, 12:30 PM - Ana: ok\n1/1/26, 12:30 PM - Ana: ok');
    expect(msgs).toHaveLength(2);
  });
});
