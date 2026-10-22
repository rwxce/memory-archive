/**
 * Platform-neutral line splitting for `_chat.txt` (Node and browser).
 *
 * Semantics mirror Node's `readline` with `crlfDelay: Infinity`, which the CLI
 * used before: `\r\n`, `\n` and a lone `\r` each end a line; empty lines in
 * the middle are emitted; a trailing line without a newline is emitted; the
 * empty string after a final newline is not. A UTF-8 BOM is dropped by
 * `TextDecoder`.
 */

/** Split decoded text chunks into lines, holding a partial line between chunks. */
export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = '';
  // A `\r` at the very end of a chunk may be the first half of `\r\n`.
  let pendingCr = false;
  for await (const chunk of chunks) {
    let text = chunk;
    if (pendingCr) {
      pendingCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      yield pending + text.slice(start, i);
      pending = '';
      if (c === 13) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 10) i++;
        } else {
          pendingCr = true;
        }
      }
      start = i + 1;
    }
    pending += text.slice(start);
  }
  if (pending) yield pending;
}

/** Decode a byte stream as UTF-8 and yield its lines. */
export function linesFromStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  return splitLines(decodeUtf8(iterateStream(stream)));
}

/** Incremental UTF-8 decoding: multi-byte sequences may span chunks. */
export async function* decodeUtf8(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Yield the lines of an in-memory string (tests, pasted text). */
export function linesFromText(text: string): AsyncGenerator<string> {
  return splitLines(
    (async function* () {
      yield text;
    })(),
  );
}

/** Yield the lines of a `Blob` / `File` (e.g. a loose `_chat.txt`). */
export function linesFromBlob(blob: Blob): AsyncGenerator<string> {
  return linesFromStream(blob.stream());
}

/** Async-iterate any web `ReadableStream`; cancels it if the consumer stops early. */
export async function* iterateStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
