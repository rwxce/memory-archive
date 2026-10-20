import { Unzip, AsyncUnzipInflate } from 'fflate';
import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import * as readline from 'node:readline';
import * as path from 'node:path';

/**
 * Stream a WhatsApp export ZIP and resolve a `readline.Interface` over the
 * decompressed `_chat.txt` content — WITHOUT buffering the whole archive or any
 * media entry (PARSE-02, PARSE-06, T-01-01, T-01-03).
 *
 * fflate's `Unzip` emits one entry at a time. We only call `file.start()` on the
 * real `_chat.txt` entry; AppleDouble `._*` companions and `__MACOSX` siblings
 * are skipped (never inflated) so videos are never buffered.
 */
export function extractChatTxt(zipPath: string): Promise<AsyncIterable<string>> {
  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate);
    let resolved = false;

    unzip.onfile = (file) => {
      const name = file.name;
      const base = name.split('/').pop() ?? '';
      const isAppleDouble =
        name.includes('__MACOSX') || base.startsWith('._');
      if (isAppleDouble || !base.endsWith('_chat.txt')) {
        return; // never call file.start() => skipped, not inflated
      }
      const pass = new PassThrough();
      file.ondata = (err, dat, final) => {
        if (err) {
          reject(err);
          return;
        }
        if (dat && dat.length) pass.write(Buffer.from(dat));
        if (final) pass.end();
      };
      file.start();
      const rl = readline.createInterface({
        input: pass,
        crlfDelay: Infinity,
      });
      // Attach the line queue HERE, before the inflate callback writes — so no
      // `line` event is ever missed (readline drops events with no listener).
      if (!resolved) {
        resolved = true;
        resolve(readLines(rl));
      }
    };

    createReadStream(zipPath)
      .on('data', (chunk: Buffer) => unzip.push(new Uint8Array(chunk)))
      .on('end', () => {
        unzip.push(new Uint8Array(0), true);
        if (!resolved) {
          reject(new Error('No _chat.txt entry found in ZIP'));
        }
      })
      .on('error', reject);
  });
}

/**
 * Event-driven async line iterator over a `readline.Interface`.
 *
 * Node's built-in `for await (const line of rl)` hangs when the underlying
 * stream is a `PassThrough` fed asynchronously by fflate's inflate callback
 * (observed on Node 26). Consuming the `line`/`close` events into a queue and
 * fulfilling a pending reader is robust and stays fully streaming (no
 * in-memory buffering of the whole `_chat.txt`).
 */
export function readLines(rl: readline.Interface): AsyncIterable<string> {
  const buffer: string[] = [];
  let resolveNext: ((value: string | null) => void) | null = null;
  let ended = false;
  rl.on('line', (l: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(l);
    } else {
      buffer.push(l);
    }
  });
  rl.on('close', () => {
    ended = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length) {
          yield buffer.shift() as string;
          continue;
        }
        if (ended) return;
        const l = await new Promise<string | null>((res) => {
          resolveNext = res;
        });
        if (l === null) return;
        yield l;
      }
    },
  };
}

/**
 * Terminal-friendly folder name (G-01-17): exports are always
 * "WhatsApp Chat - <name>.zip", so strip the prefix and slugify —
 * diacritics removed, lowercase, non-alphanumeric runs collapsed to `-`.
 * `WhatsApp Chat - Plataforma WK` -> `plataforma-wk`.
 */
export function slugifyChatName(name: string): string {
  return name
    .replace(/^whatsapp chat\s*-\s*/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Resolve the raw chat name (e.g. `WhatsApp Chat - Plataforma WK`). */
function rawChatName(names: string[], zipPath: string): string {
  const chatEntry = names.find((n) => {
    const base = n.split('/').pop() ?? '';
    const isAppleDouble = n.includes('__MACOSX') || base.startsWith('._');
    return !isAppleDouble && base.endsWith('_chat.txt');
  });
  if (!chatEntry) {
    throw new Error('No _chat.txt entry found in ZIP');
  }
  const parts = chatEntry.split('/');
  // Real WhatsApp exports keep `_chat.txt` at the archive ROOT (no folder) —
  // derive the chat name from the ZIP file basename in that case (G-01-16).
  return parts.length > 1
    ? parts[0]
    : path.basename(zipPath).replace(/\.zip$/i, '');
}

/**
 * Open the ZIP, read ONLY entry names (never inflate), and return the chat's
 * top-level folder name (e.g. `WhatsApp Chat - Plataforma WK`) sanitized for
 * safe use as a directory name (strips `/` and `..`, T-01-01).
 */
export async function chatNameFromZip(zipPath: string): Promise<string> {
  const names = await new Promise<string[]>((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate);
    const collected: string[] = [];
    unzip.onfile = (file) => {
      collected.push(file.name); // header only; never start() => not inflated
    };
    createReadStream(zipPath)
      .on('data', (chunk: Buffer) => unzip.push(new Uint8Array(chunk)))
      .on('end', () => {
        unzip.push(new Uint8Array(0), true);
        resolve(collected);
      })
      .on('error', reject);
  });
  const raw = rawChatName(names, zipPath);
  const slug = slugifyChatName(raw);
  return slug || 'chat';
}

/**
 * Like `chatNameFromZip` but returns both the directory slug and the
 * human-readable display name (the chat title without the `WhatsApp Chat - `
 * prefix). Used by the render pipeline for `metadata.chatName`.
 */
export async function chatInfoFromZip(
  zipPath: string,
): Promise<{ slug: string; name: string }> {
  const names = await new Promise<string[]>((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate);
    const collected: string[] = [];
    unzip.onfile = (file) => {
      collected.push(file.name);
    };
    createReadStream(zipPath)
      .on('data', (chunk: Buffer) => unzip.push(new Uint8Array(chunk)))
      .on('end', () => {
        unzip.push(new Uint8Array(0), true);
        resolve(collected);
      })
      .on('error', reject);
  });
  const raw = rawChatName(names, zipPath);
  const slug = slugifyChatName(raw) || 'chat';
  const name = raw.replace(/^whatsapp chat\s*-\s*/i, '').trim() || slug;
  return { slug, name };
}
