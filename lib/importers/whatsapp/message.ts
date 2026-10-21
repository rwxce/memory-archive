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
/** iOS media marker, per export language: `<attached: F>` (en),
 * `<adjunto: F>` (es), `<anexado: F>` (pt), `<adjunt: F>` (ca). */
const ATTACHED_RE = /<(?:attached|adjunto|anexado|adjunt):\s*([^>]+?)>/;
/** Android media marker: the whole first line is `F (file attached)`, with
 * the caption (if any) on the following lines. */
const FILE_ATTACHED_RE =
  /^(\S(?:[^\n]*?\S)?\.[A-Za-z0-9]{1,5})\s+\((?:file attached|archivo adjunto|arquivo anexado|fitxer adjunt)\)\s*$/i;

/** Media nouns and "omitted" words in en / pt / es / ca. Written without `\b`
 * because JS word boundaries ignore accented letters. */
const OMIT_MEDIA =
  '(?:media|multimedia|multim[eè]dia|m[ií]dia|image|imagen|imagem|imatge|video|v[ií]deo|' +
  'audio|[aáà]udio|sticker|figurinha|document|documento|gif)';
const OMIT_WORD = '(?:omitted|omitid[oa]s?|ocult[oa]|ocultad[oa]|om[eè]s|omes[ao]s?)';
/** `<Media omitted>` / `image omitted` / `<Mídia oculta>` / `<Multimedia omitido>` /
 *  `*.pdf • N páginas document omitted` — brackets are OPTIONAL because real
 *  Android exports drop them (MEDIA-04). */
const OMITTED_RE = new RegExp(`<?\\s*${OMIT_MEDIA}\\s+${OMIT_WORD}\\s*>?`, 'i');
/** Deleted-message markers (en, pt, es, ca), whole-body match (D-15). */
const DELETED_RE = new RegExp(
  '^(?:message deleted|this message was deleted|you deleted this message|' +
    'mensagem apagada|esta mensagem foi apagada|voc[eê] apagou esta mensagem|' +
    'se elimin[oó] este mensaje|este mensaje fue eliminado|eliminaste este mensaje|' +
    "s['’]ha suprimit aquest missatge|aquest missatge s['’]ha suprimit|has suprimit aquest missatge)\\.?$",
  'i',
);

/** Voice notes and audio files: by extension, or WhatsApp's `PTT-` / `AUD-` /
 * `-AUDIO-` file-name markers. */
const AUDIO_EXT_RE = /\.(opus|m4a|mp3|ogg)$/i;
const AUDIO_NAME_RE = /(^|[^A-Z])(PTT|AUD)-|-AUDIO-/;

function classifyFromFilename(filename: string): MessageType {
  const f = filename.toUpperCase();
  // iOS: `00000008-STICKER-…`, `-PHOTO-`, `-VIDEO-`; Android: `STK-`, `IMG-`, `VID-`.
  if (f.includes('STICKER') || /(^|[^A-Z])STK-/.test(f)) return 'sticker';
  if (AUDIO_EXT_RE.test(filename) || AUDIO_NAME_RE.test(f)) return 'audio';
  if (f.includes('PHOTO') || f.includes('IMG')) return 'photo';
  if (f.includes('VIDEO') || /(^|[^A-Z])VID-/.test(f)) return 'video';
  // No name marker: fall back to the extension.
  if (/\.(jpe?g|png|heic|gif)$/i.test(filename)) return 'photo';
  if (/\.(mp4|mov|3gp|mkv|webm)$/i.test(filename)) return 'video';
  if (/\.webp$/i.test(filename)) return 'sticker';
  return 'document';
}

/**
 * Whether a media file name is a video by the importer's own rule (what `skipVideos` skips).
 * Pass the base name; the ZIP directory is not part of the file's identity.
 */
export const isVideoFileName = (filename: string): boolean => classifyFromFilename(filename) === 'video';

/**
 * Type classification order (research §3.3):
 * attached → omitted-marker → deleted-marker → system → text.
 * `media` non-null means an attachment marker was consumed.
 * `systemMark`: iOS writes system events as `[ts] <Group>: \u200eAna added Bo`
 * — a sender (the chat) whose body starts with U+200E.
 */
export function classifyType(
  body: string,
  media: string | null,
  hasSender: boolean,
  systemMark = false,
): MessageType {
  if (media) return classifyFromFilename(media);
  const t = trimInvisible(body).trim();
  if (OMITTED_RE.test(t)) return 'omitted';
  if (DELETED_RE.test(t)) return 'deleted';
  if (!hasSender || systemMark) return 'system';
  return 'text';
}

/** Find an attachment marker in a message body: `{ media, text }` or null. */
export function extractAttachment(body: string): { media: string; text: string } | null {
  const ios = body.match(ATTACHED_RE);
  if (ios) {
    return { media: ios[1].trim(), text: trimInvisible(body.replace(ATTACHED_RE, '')).trim() };
  }
  const android = body.match(FILE_ATTACHED_RE);
  if (android) {
    return { media: android[1].trim(), text: trimInvisible(body.slice(android[0].length)).trim() };
  }
  return null;
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
    // Android system lines have no sender: drop the ` - ` separator too.
    let body = senderMatch ? senderMatch[2] : afterTs.replace(/^\s*-\s+/, '');
    const systemMark = Boolean(senderMatch) && body.trimStart().startsWith('\u200e');
    body = trimInvisible(body).trim();

    const attached = extractAttachment(body);
    const media = attached ? attached.media : null;
    const text = attached ? attached.text : body;
    const type = classifyType(body, media, Boolean(senderMatch), systemMark);

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
