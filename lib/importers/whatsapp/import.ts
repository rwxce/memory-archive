import { chatLines, openChatZip } from './chat';
import { createFormatDetector } from './timestamp';
import type { ChatInfo } from './chat';
import { parseMessages } from './message';
import type { Detection } from './timestamp';
import type { Message } from './types';
import type { ReadZipOptions, ZipEntry } from './zip';

export interface ParsedChat {
  info: ChatInfo;
  /** All archive entries (media are resolved against these). */
  entries: ZipEntry[];
  messages: Message[];
  /** File-level format decision; undefined only for an empty transcript. */
  detection?: Detection;
  /** Invalid / out-of-range dates kept as continuation lines. */
  warnings: string[];
}

export interface WhatsAppZipStream {
  info: ChatInfo;
  entries: ZipEntry[];
  detection?: Detection;
  /** Fills while `messages` is consumed. */
  warnings: string[];
  messages: AsyncGenerator<Message>;
}

export interface StreamOptions {
  dayFirst?: boolean;
  monthFirst?: boolean;
  limits?: ReadZipOptions & { maxChatBytes?: number };
  /** Checked on every line of the format pass and of the parse: aborting stops the read. */
  signal?: AbortSignal;
}

/**
 * Open a WhatsApp export ZIP and stream its messages: central directory -> format pass over the
 * `_chat.txt` stream (constant memory) -> a generator of messages (a second constant-memory pass).
 * Nothing but the current message is held. The day/month order is decided from the WHOLE
 * transcript before the first message is produced.
 */
export async function streamWhatsAppZip(zip: Blob, zipFileName: string, opts: StreamOptions = {}): Promise<WhatsAppZipStream> {
  const { entries, chatEntry, info } = await openChatZip(zip, zipFileName, opts.limits);
  const warnings: string[] = [];
  const detector = createFormatDetector();
  for await (const line of chatLines(zip, chatEntry)) {
    opts.signal?.throwIfAborted();
    detector.add(line);
  }
  const detection: Detection | undefined = detector.seenTimestamp()
    ? detector.result({ dayFirst: opts.dayFirst, monthFirst: opts.monthFirst })
    : undefined;
  async function* messages(): AsyncGenerator<Message> {
    for await (const m of parseMessages(chatLines(zip, chatEntry), {
      dayFirst: opts.dayFirst,
      monthFirst: opts.monthFirst,
      detection,
      warnings,
    })) {
      opts.signal?.throwIfAborted();
      yield m;
    }
  }
  return { info, entries, detection, warnings, messages: messages() };
}

/**
 * Parse a WhatsApp export ZIP end to end (all messages in memory). Works on a browser `File`
 * and on a Node blob alike.
 */
export async function parseWhatsAppZip(
  zip: Blob,
  zipFileName: string,
  opts: { dayFirst?: boolean; monthFirst?: boolean; limits?: ReadZipOptions & { maxChatBytes?: number } } = {},
): Promise<ParsedChat> {
  const stream = await streamWhatsAppZip(zip, zipFileName, opts);
  const messages: Message[] = [];
  for await (const m of stream.messages) messages.push(m);
  return { info: stream.info, entries: stream.entries, messages, detection: stream.detection, warnings: stream.warnings };
}
