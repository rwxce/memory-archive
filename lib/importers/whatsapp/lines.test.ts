import { describe, expect, test } from 'vitest';
import { decodeUtf8, linesFromStream, linesFromText, splitLines } from './lines';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

describe('splitLines (readline crlfDelay: Infinity semantics)', () => {
  test('LF, CRLF and lone CR all end a line', async () => {
    expect(await collect(linesFromText('a\nb\r\nc\rd'))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('empty middle lines are kept; trailing newline adds no empty line', async () => {
    expect(await collect(linesFromText('a\n\nb\n'))).toEqual(['a', '', 'b']);
  });

  test('CRLF split across chunks is one line break', async () => {
    expect(await collect(splitLines(chunks('a\r', '\nb')))).toEqual(['a', 'b']);
  });

  test('a line split across chunks is joined', async () => {
    expect(await collect(splitLines(chunks('hel', 'lo\nwor', 'ld')))).toEqual(['hello', 'world']);
  });

  test('empty input yields nothing', async () => {
    expect(await collect(linesFromText(''))).toEqual([]);
  });
});

describe('linesFromStream', () => {
  test('multi-byte UTF-8 split across chunks decodes correctly', async () => {
    const bytes = new TextEncoder().encode('Olá, João\nação');
    // Split inside the two-byte "á".
    const cut = 3;
    const lines = await collect(linesFromStream(streamOf(bytes.subarray(0, cut), bytes.subarray(cut))));
    expect(lines).toEqual(['Olá, João', 'ação']);
  });

  test('a UTF-8 BOM is dropped', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('x\ny')]);
    expect(await collect(linesFromStream(streamOf(bytes)))).toEqual(['x', 'y']);
  });

  test('decodeUtf8 flushes a trailing partial sequence as U+FFFD', async () => {
    async function* one() {
      yield new Uint8Array([0x61, 0xc3]);
    }
    expect((await collect(decodeUtf8(one()))).join('')).toBe('a�');
  });
});
