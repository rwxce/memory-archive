import { normalizeText } from '../../domain/fingerprint';
import { linesFromStream } from './lines';
import { ZipLimitError, openZipEntry, readZipEntries } from './zip';
import type { ReadZipOptions, ZipEntry } from './zip';

/** macOS resource-fork companions (`__MACOSX/`, `._name`): never real content. */
export function isAppleDouble(name: string): boolean {
  const base = name.split('/').pop() ?? '';
  return name.includes('__MACOSX') || base.startsWith('._');
}

/** Last path segment of a ZIP entry name. */
export function entryBaseName(name: string): string {
  return name.split('/').pop() ?? '';
}

/** True for the chat transcript entry (`_chat.txt`, any folder). */
export function isChatEntry(name: string): boolean {
  return !isAppleDouble(name) && entryBaseName(name).endsWith('_chat.txt');
}

/** First `_chat.txt` entry of the archive (AppleDouble companions skipped). */
export function findChatEntry<T extends { name: string }>(entries: T[]): T | undefined {
  return entries.find((e) => isChatEntry(e.name));
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
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ChatInfo {
  /** Safe directory slug, e.g. `plataforma-wk`. */
  slug: string;
  /** Human-readable chat title without the `WhatsApp Chat - ` prefix. */
  name: string;
}

/**
 * Resolve the chat's slug and display name from the archive's entry names.
 * Real WhatsApp exports keep `_chat.txt` at the archive ROOT — the name then
 * comes from the ZIP file name (G-01-16); otherwise from the top folder.
 * `zipFileName` is a base name (`WhatsApp Chat - X.zip`), not a path.
 */
export function chatInfoFromEntryNames(names: string[], zipFileName: string): ChatInfo {
  const chatEntry = names.find(isChatEntry);
  if (!chatEntry) throw new Error('No _chat.txt entry found in ZIP');
  const parts = chatEntry.split('/');
  const base = (zipFileName.split(/[\\/]/).pop() ?? '').replace(/\.zip$/i, '');
  const raw = parts.length > 1 ? parts[0] : base;
  const slug = slugifyChatName(raw) || 'chat';
  const name = raw.replace(/^whatsapp chat\s*-\s*/i, '').trim() || slug;
  return { slug, name };
}

/**
 * Prefixes WhatsApp puts before the chat name in an export's file name, by language
 * (`WhatsApp Chat - X`, `WhatsApp Chat with X`, `Chat de WhatsApp con X`,
 * `Conversa do WhatsApp com X`, `Xat de WhatsApp amb X`), and the `00000068-` counter that
 * some exports prepend.
 */
const TITLE_PREFIX_RE =
  /^(?:\d{8}-)?(?:whatsapp chat\s*(?:-|with)\s*|chat de whatsapp con\s+|conversa do whatsapp com\s+|conversa de whatsapp amb\s+|xat de whatsapp amb\s+)/i;

/** The chat's own name without any language's export prefix (falls back to `name` when nothing is left). */
export function chatTitleOf(name: string): string {
  const title = normalizeText(name).replace(/\s+/gu, ' ').replace(TITLE_PREFIX_RE, '').trim();
  return title || normalizeText(name).trim() || 'chat';
}

/**
 * The stable key of "the same chat" across exports: the title without the export's language
 * prefix, case-folded. It is only a candidate filter, never proof: different chats share names
 * (and a phone may call every export `chat.zip`). `importWhatsAppExport` merges only when the
 * key matches AND messages of the export are already stored in that conversation; otherwise it
 * returns `ambiguous` and the caller decides.
 */
export function chatKeyOf(name: string): string {
  return chatTitleOf(name).toLowerCase();
}

export interface OpenedChatZip {
  entries: ZipEntry[];
  chatEntry: ZipEntry;
  info: ChatInfo;
}

/** Read the central directory and locate the transcript. */
export async function openChatZip(
  zip: Blob,
  zipFileName: string,
  limits: ReadZipOptions & { maxChatBytes?: number } = {},
): Promise<OpenedChatZip> {
  const entries = await readZipEntries(zip, limits);
  const chatEntry = findChatEntry(entries);
  if (!chatEntry) throw new Error('No _chat.txt entry found in ZIP');
  if (limits.maxChatBytes !== undefined && chatEntry.uncompressedSize > limits.maxChatBytes) {
    throw new ZipLimitError('the chat transcript is too large');
  }
  return { entries, chatEntry, info: chatInfoFromEntryNames(entries.map((e) => e.name), zipFileName) };
}

/** Stream the transcript's lines (constant memory, any chat size). */
export function chatLines(zip: Blob, chatEntry: ZipEntry): AsyncGenerator<string> {
  return linesFromStream(openZipEntry(zip, chatEntry));
}
