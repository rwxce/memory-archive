import { linesFromText } from '../whatsapp/lines';
import { parseMessages } from '../whatsapp/message';
import { ZipLimitError } from '../whatsapp/zip';
import type { Message, MessageType } from '../whatsapp/types';
import { readLegacyOutput } from './read';
import { LegacyFormatError } from './types';

/**
 * Old wa-backup / memory-archive outputs (`messages.json`, `messages.html`, `messages.csv`) as an
 * import source. They already hold parsed messages, but everything after the picker reads a
 * WhatsApp transcript, so the messages are written back as an iOS-style `_chat.txt` and the usual
 * parser reads it again: fingerprints are computed by the same code as for a ZIP of the same chat,
 * and preview, dedupe, undo and history are unchanged. Nothing is rendered as HTML: the HTML
 * output is only read for its JSON data island.
 *
 * The content decides, not the name: the first bytes must look like a JSON envelope, an HTML page
 * or the CSV header. Anything else is not ours (`null`).
 *
 * What is guaranteed: the transcript is parsed back with the real WhatsApp parser and compared with
 * the input (count, timestamp, author, type, text, attachment file name). Any difference throws
 * `LegacyFormatError` and nothing is imported; text is never altered to make it fit. The only
 * normalizations are line endings (`\r\n` and `\r` become `\n`, as the line splitter would read
 * them) and the attachment path, reduced to its file name (`>` and line breaks in it become `_`).
 * Messages that cannot be written faithfully (a continuation line that looks like a timestamped
 * message, an author with ": " or edge spaces, text with trailing spaces, a text that the parser
 * would re-type, ...) are refused rather than altered. What it cannot keep:
 * the media files (the outputs only reference them by relative path, so every attachment is
 * imported as a message whose file is missing), the seconds of an Android chat (they were never in
 * the fingerprint) and the chat name of a CSV (it records none).
 */

/** Largest legacy file read into memory (JSON and HTML hold the whole chat as one string). */
export const MAX_LEGACY_BYTES = 64 * 1024 * 1024;

/** Bytes inspected to recognise the format. */
const SNIFF_BYTES = 4096;

const TYPES: ReadonlySet<string> = new Set<MessageType>(['text', 'photo', 'video', 'sticker', 'document', 'audio', 'system', 'deleted', 'omitted']);
const LOCAL_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/;
/** U+200E: how iOS marks a system event written under the chat's name. */
const LRM = '‎';

export interface LegacyTranscript {
  /** The `_chat.txt` text, day-first `[dd/mm/yyyy, HH:MM:SS]`, 24 h. */
  transcript: Blob;
  /** The chat name the output records (JSON / HTML), when it has one. */
  chatName?: string;
  messageCount: number;
}

function looksLegacy(head: string): boolean {
  const s = head.replace(/^\ufeff/, '').trimStart();
  return s.startsWith('{') || /^<(!doctype|html)/i.test(s) || s.startsWith('timestamp_iso,');
}

/** The attachment name as the transcript writes it (the part of the path after the last `/`). */
function fileOf(media: string): string {
  return (media.slice(media.lastIndexOf('/') + 1) || media).replace(/[>\r\n]/g, '_');
}

const eol = (s: string): string => s.replace(/\r\n?/g, '\n');

/** The message as the transcript is expected to read back. */
function expectedOf(m: Message): Message {
  return { ...m, text: eol(m.text), media: m.media === '' ? '' : fileOf(m.media) };
}

/** One header-less line per message; continuation lines (multi-line text) follow it. */
function lineOf(m: Message): string {
  const ts = LOCAL_TS.exec(m.timestamp_iso);
  if (!ts) throw new LegacyFormatError('a message has no valid timestamp');
  if (!TYPES.has(m.type)) throw new LegacyFormatError(`a message has an unknown type "${m.type.slice(0, 20)}"`);
  if (/[\r\n]/.test(m.author)) throw new LegacyFormatError('an author contains a line break');
  const stamp = `[${ts[3]}/${ts[2]}/${ts[1]}, ${ts[4]}]`;
  const sender = m.author === '' ? '' : `${m.author}: `;
  const text = eol(m.text);
  if (m.media !== '') return `${stamp} ${sender}<attached: ${fileOf(m.media)}>${text === '' ? '' : `\n${text}`}`;
  const body = m.type === 'system' && m.author !== '' ? `${LRM}${text}` : text;
  return body === '' ? `${stamp} ${sender}`.trimEnd() : `${stamp} ${sender}${body}`;
}

/**
 * The transcript for a list of messages, in order. It is read back with the WhatsApp parser and
 * must give exactly the input messages; otherwise `LegacyFormatError` (nothing is altered to fit).
 */
export async function transcriptOfMessages(messages: Message[]): Promise<string> {
  const transcript = messages.map(lineOf).join('\n');
  const want = messages.map(expectedOf);
  let i = 0;
  for await (const got of parseMessages(linesFromText(transcript), { dayFirst: true })) {
    const w = want[i++];
    if (!w || got.timestamp_iso !== w.timestamp_iso || got.type !== w.type || got.author !== w.author || got.text !== w.text || got.media !== w.media) {
      throw new LegacyFormatError(`message ${i} cannot be written back faithfully`);
    }
  }
  if (i !== want.length) throw new LegacyFormatError('the messages cannot be written back faithfully (the count differs)');
  return transcript;
}

/**
 * Read a legacy output and render it as a transcript. Returns `null` when the file does not look
 * like one (so the caller can treat it as text or a ZIP); throws `ZipLimitError` over the size cap
 * and `LegacyFormatError` when it looks like one but is not a valid output (unknown schema, bad
 * timestamps, Markdown is never recognised).
 */
export async function legacyAsTranscript(file: Blob, maxBytes: number): Promise<LegacyTranscript | null> {
  if (file.size === 0) return null;
  const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  if (!looksLegacy(head)) return null;
  if (file.size > Math.min(maxBytes, MAX_LEGACY_BYTES)) throw new ZipLimitError('the file is too large');

  const archive = readLegacyOutput('', await file.text()) // no name: the content picks the reader;
  if (archive.messages.length === 0) throw new LegacyFormatError('the file holds no messages');
  return {
    transcript: new Blob([await transcriptOfMessages(archive.messages)], { type: 'text/plain' }),
    chatName: archive.chatName,
    messageCount: archive.messages.length,
  };
}
