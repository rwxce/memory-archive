import type { Message, MessageType } from './types';
import {
  stripInvisible,
  trimInvisible,
  TS_RE,
  detectFormat,
  tryParseTimestamp,
} from './timestamp';
import type { Detection } from './timestamp';

/** Sender separator (D-09): optional ` - ` wrapper, then `Name: body`.
 * The separator is `:` + whitespace, or `:` at end-of-line (empty-body
 * messages like `[..] Camilla:`). Requiring `\s|$` keeps URLs (`https://…`)
 * from being mistaken for senders. */
const SENDER_RE = /^(?:\s*-\s*)?(.+?):(?:\s|$)([\s\S]*)$/;
/** `<attached: FILENAME>` media marker. */
const ATTACHED_RE = /<attached:\s*([^>]+?)>/;
/** `<Media omitted>` / `image omitted` / `sticker omitted` /
 *  `*.pdf • N páginas document omitted` — brackets are OPTIONAL because real
 *  Android exports drop them (MEDIA-04). */
const OMITTED_RE = /<?\s*(?:media|image|video|sticker|document|audio|gif)\s+omitted\s*>?/i;
/** Deleted-message markers (pt-BR + EN), whole-body match (D-15). */
const DELETED_RE =
  /^(mensagem apagada|message deleted|this message was deleted)\.?$/i;

function classifyFromFilename(filename: string): MessageType {
  const f = filename.toUpperCase();
  if (f.includes('STICKER')) return 'sticker';
  if (f.includes('PHOTO') || f.includes('IMG')) return 'photo';
  if (f.includes('VIDEO')) return 'video';
  // No `audio` type exists in the locked 8; fallback to document (A1).
  return 'document';
}

/**
 * Type classification order (research §3.3):
 * attached → omitted-marker → deleted-marker → system → text.
 * `media` non-null means an `<attached:` marker was consumed.
 */
export function classifyType(
  body: string,
  media: string | null,
  hasSender: boolean,
): MessageType {
  if (media) return classifyFromFilename(media);
  const t = trimInvisible(body).trim();
  if (OMITTED_RE.test(t)) return 'omitted';
  if (DELETED_RE.test(t)) return 'deleted';
  if (!hasSender) return 'system';
  return 'text';
}

export interface ParseOptions {
  dayFirst?: boolean;
  monthFirst?: boolean;
  /** Pre-computed file-level detection; skips in-stream sampling. */
  detection?: Detection;
  /** Collector for verbose warnings (D-07): invalid/out-of-range dates. */
  warnings?: string[];
  /** Called once the file-level format decision resolves (D-07 reporting). */
  onDetection?: (d: Detection) => void;
}

/** Sample window for the in-stream format vote (PARSE-03). */
const SAMPLE_LINES = 200;

/**
 * Streaming line state-machine parser (RESEARCH §3).
 *
 * - Non-timestamp line => append to open message's `text` (continuation, PARSE-04).
 * - Timestamp that fails to parse (invalid/out-of-range, D-04/D-08) => continuation
 *   (+ optional warning collected into `opts.warnings`).
 * - Format detection runs ONCE per file over a bounded sample of the first
 *   lines (lazy buffered while streaming — single pass, PARSE-03).
 * - Empty-body timestamped line is HELD; if the next line is a same-author
 *   attachment it merges into ONE media row (no phantom empty row, §3.4).
 * - Each `<attached>` line is its own row; dedupe key (in plan 03) keeps
 *   same-second bursts distinct (D-16).
 * - author preserved RAW (incl. bidi wrappers, ~ prefix); bodies invisible-
 *   stripped and whitespace-trimmed.
 */
export async function* parseMessages(
  lines: AsyncIterable<string>,
  opts: ParseOptions = {},
): AsyncGenerator<Message> {
  let current: Message | null = null;
  let heldEmpty: Message | null = null;
  let detection: Detection | undefined = opts.detection;
  const buffer: string[] = [];
  const warnings = opts.warnings;

  const appendContinuation = (line: string) => {
    const target = current ?? heldEmpty;
    if (!target) return;
    target.text = target.text ? target.text + '\n' + line : line;
    // If the held-empty message gained text, it is no longer "empty" => promote.
    if (target === heldEmpty && target.text) {
      current = heldEmpty;
      heldEmpty = null;
    }
  };

  const processLine = (raw: string) => {
    const stripped = stripInvisible(raw);
    const tsMatch = TS_RE.exec(stripped);

    if (!tsMatch) {
      appendContinuation(raw);
      return;
    }

    const parsed = tryParseTimestamp(stripped, detection!, warnings);
    if (!parsed) {
      // D-04 / D-08: matched the shape but not a usable date => continuation.
      appendContinuation(raw);
      return;
    }

    const afterTs = stripped.slice(tsMatch[0].length);
    const senderMatch = SENDER_RE.exec(afterTs);
    const author = senderMatch ? senderMatch[1].trim() : '';
    let body = senderMatch ? senderMatch[2] : afterTs;
    body = trimInvisible(body).trim();

    const attached = body.match(ATTACHED_RE);
    const media = attached ? attached[1].trim() : null;
    const text = media ? trimInvisible(body.replace(ATTACHED_RE, '')).trim() : body;
    const type = classifyType(body, media, Boolean(senderMatch));

    const msg: Message = {
      timestamp_iso: parsed.iso,
      type,
      author,
      text,
      media: media ?? '',
    };

    // Merge held-empty with an incoming same-author attachment (§3.4).
    if (heldEmpty && msg.media && msg.author === heldEmpty.author) {
      heldEmpty = null; // discard empty holder; msg becomes the merged media row
    } else if (heldEmpty) {
      emit(heldEmpty);
      heldEmpty = null;
    }

    if (current) {
      emit(current);
      current = null;
    }

    if (msg.text === '' && !msg.media) {
      heldEmpty = msg;
    } else {
      current = msg;
    }
  };

  // Emitting inside a generator via callback closure.
  const queue: Message[] = [];
  function emit(m: Message) {
    queue.push(m);
  }

  for await (const raw of lines) {
    if (!detection) {
      buffer.push(raw);
      if (buffer.length >= SAMPLE_LINES) {
        detection = detectFormat(buffer, opts);
        opts.onDetection?.(detection);
        for (const l of buffer) processLine(l);
        buffer.length = 0;
      }
    } else {
      processLine(raw);
    }
    while (queue.length) yield queue.shift() as Message;
  }

  if (!detection && buffer.length) {
    detection = detectFormat(buffer, opts);
    opts.onDetection?.(detection);
    for (const l of buffer) processLine(l);
    buffer.length = 0;
  }
  if (heldEmpty) emit(heldEmpty);
  if (current) emit(current);
  while (queue.length) yield queue.shift() as Message;
}
