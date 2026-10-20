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
