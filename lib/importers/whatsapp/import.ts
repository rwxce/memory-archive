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

/**
 * Parse a WhatsApp export ZIP end to end: central directory → `_chat.txt`
 * stream → messages. Works on a browser `File` and on a Node blob alike.
 */
export async function parseWhatsAppZip(
  zip: Blob,
  zipFileName: string,
  opts: { dayFirst?: boolean; monthFirst?: boolean; limits?: ReadZipOptions & { maxChatBytes?: number } } = {},
): Promise<ParsedChat> {
  const { entries, chatEntry, info } = await openChatZip(zip, zipFileName, opts.limits);
  const warnings: string[] = [];
  const messages: Message[] = [];
  // The day/month order is decided from the WHOLE transcript before parsing: one date with a
  // component >= 13 anywhere settles it (a first pass over the stream, constant memory).
  const detector = createFormatDetector();
  for await (const line of chatLines(zip, chatEntry)) detector.add(line);
  const detection: Detection | undefined = detector.seenTimestamp()
    ? detector.result({ dayFirst: opts.dayFirst, monthFirst: opts.monthFirst })
    : undefined;
  for await (const m of parseMessages(chatLines(zip, chatEntry), {
    dayFirst: opts.dayFirst,
    monthFirst: opts.monthFirst,
    detection,
    warnings,
  })) {
    messages.push(m);
  }
  return { info, entries, messages, detection, warnings };
}
