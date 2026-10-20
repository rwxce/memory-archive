import { chatLines, openChatZip } from './chat';
import type { ChatInfo } from './chat';
import { parseMessages } from './message';
import type { Detection } from './timestamp';
import type { Message } from './types';
import type { ZipEntry } from './zip';

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
  opts: { dayFirst?: boolean; monthFirst?: boolean } = {},
): Promise<ParsedChat> {
  const { entries, chatEntry, info } = await openChatZip(zip, zipFileName);
  const warnings: string[] = [];
  let detection: Detection | undefined;
  const messages: Message[] = [];
  for await (const m of parseMessages(chatLines(zip, chatEntry), {
    dayFirst: opts.dayFirst,
    monthFirst: opts.monthFirst,
    warnings,
    onDetection: (d) => {
      detection = d;
    },
  })) {
    messages.push(m);
  }
  return { info, entries, messages, detection, warnings };
}
