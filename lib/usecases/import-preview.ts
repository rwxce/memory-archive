import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import type { ImportCandidate } from '../db/queries';
import { isUuid } from '../domain/library';
import { chatKeyOf, chatTitleOf, entryBaseName, isAppleDouble, isChatEntry } from '../importers/whatsapp/chat';
import { streamWhatsAppZip } from '../importers/whatsapp/import';
import { matchMediaEntries, normalizeMediaName } from '../importers/whatsapp/media';
import { classifyFromFilename } from '../importers/whatsapp/message';
import type { MessageType } from '../importers/whatsapp/types';
import type { StorageStatus } from '../storage/quota';
import {
  createMessageDrafter,
  DEFAULT_IMPORT_LIMITS,
  guessIsGroup,
  ImportError,
  matchConversation,
  zipProblem,
  type ConversationTarget,
  type ImportLimits,
} from './import';
import { estimateImport, type ImportSpaceEstimate } from './import-space';

/**
 * A read-only look at a WhatsApp export before importing it: what is in it, who wrote it, how its
 * dates read, how much space it needs and what the import would do to the library. It writes
 * nothing: its dependencies are the database client (reads only: `listConversations`,
 * `findImportCandidates`, `findExistingFingerprints`) and NO blob store, so it cannot store media
 * and takes no archive lock. It can run in the import worker (`previewWhatsAppExportInWorker` in `import-client.ts`).
 *
 * The preview and the import share their code, not just their rules: the same streaming parser
 * (`streamWhatsAppZip`), the same fingerprinter (`createMessageDrafter`), the same conversation
 * matching (`matchConversation`), the same group guess (`guessIsGroup`), the same media matching
 * and the same limits. So for the same file, library and options, `duplicates.alreadyThere` and
 * `wouldAdd` equal the `alreadyThere` and `added` of the import that follows.
 *
 * Memory: the transcript is streamed twice (format pass, parse pass) and only the fingerprints
 * (64 characters per message), the author table (capped) and the media names are kept.
 *
 * Concurrency: advisory by design. The answer describes the library at the moment of the read;
 * the import decides again under the archive lock, so a preview that raced a write is never
 * wrong in a harmful way. The page refuses to start one while an archive operation (restore,
 * import, backup...) runs in this tab (`previewWhatsAppExportInWorker`), because a restore replaces
 * what the preview would read.
 */

/** Authors listed at most; a bigger chat sets `authorsTruncated` (and counts as a group). */
export const MAX_PREVIEW_AUTHORS = 200;

/** Messages between two `reading` progress reports. */
const READING_REPORT_EVERY = 2000;
/** Fingerprints per `findExistingFingerprints` request. */
const MATCH_CHUNK = 5000;

export interface PreviewWhatsAppInput {
  zip: Blob;
  /** Base name of the ZIP (untrusted; the chat name comes from it), as in the import. */
  fileName: string;
  /** Profiles the conversation would be filed under: duplicates are looked for among their chats. */
  profileIds: string[];
  conversation?: ConversationTarget;
  dayFirst?: boolean;
  monthFirst?: boolean;
  /** Plain numbers from `readStorageStatus`, for the space estimate; unknown by default. */
  storage?: Pick<StorageStatus, 'usage' | 'quota'>;
  limits?: Partial<ImportLimits>;
}

export type PreviewProgress =
  /** `done`: messages parsed so far (the total is unknown until the end). */
  | { phase: 'reading'; done: number }
  | { phase: 'matching'; done: number; total: number };

export interface PreviewControl {
  signal?: AbortSignal;
  onProgress?: (progress: PreviewProgress) => void;
}

export interface PreviewAuthor {
  /** As the import would store it (normalized). */
  name: string;
  messageCount: number;
  /** Mostly digits: a contact that is not saved on the exporting phone. */
  looksLikePhoneNumber: boolean;
}

export interface PreviewMediaKind {
  count: number;
  bytes: number;
}

export type PreviewDuplicates =
  /** No chat in scope is this one: the import creates a conversation. */
  | { status: 'new' }
  /** The import adds to this conversation. `wouldAdd + alreadyThere` is `messageCount`. */
  | {
      status: 'existing';
      conversationId: string;
      title: string;
      /** Messages stored in it today. */
      storedCount: number;
      alreadyThere: number;
      wouldAdd: number;
    }
  | { status: 'ambiguous'; reason: 'same-title' | 'same-title-no-overlap' | 'overlap'; candidates: ImportCandidate[] }
  /** Every date reads both ways: the person must choose day-first or month-first (`dateFormat.preview`). */
  | { status: 'date-format' };

export interface ImportPreview {
  chatTitle: string;
  /** The stable key the import matches chats by. */
  sourceKey: string;
  /** More than two authors (`guessIsGroup`). */
  isGroup: boolean;
  /** Messages the import would process, system messages included. */
  messageCount: number;
  /** `YYYY-MM-DDTHH:mm:ss`, local time without zone, as stored. */
  firstAt: string;
  lastAt: string;
  /** Most active first; system messages have no author. At most `MAX_PREVIEW_AUTHORS`. */
  authors: PreviewAuthor[];
  authorsTruncated: boolean;
  /** `suggestMe`: the author to pre-select as "me", only when it is unambiguous. */
  suggestedMe: string | null;
  dateFormat: { dayFirst: boolean; ambiguous: boolean; preview?: { dayFirst: string; monthFirst: string } };
  /** Lines that looked like a message start but have an unusable date (see `ImportSummary.rawLines`). */
  rawLines: number;
  media: {
    /** Files in the ZIP other than the transcript, by kind, from the central directory. */
    byKind: Partial<Record<MessageType, PreviewMediaKind>>;
    totalCount: number;
    totalBytes: number;
    /** Distinct files the chat refers to that the ZIP does not contain. */
    missing: number;
  };
  space: ImportSpaceEstimate;
  duplicates: PreviewDuplicates;
}

/** Digits with separators: `+34 612 34 56 78`, `(555) 010-9999`. Not a name. */
export function looksLikePhoneNumber(name: string): boolean {
  return name.replace(/\D/gu, '').length >= 6 && /^[+\d\s().-]+$/u.test(name);
}

/**
 * Which author is probably the person themselves. Only when it is unambiguous: a two-person chat
 * (exactly two authors, none cut off by the cap) where exactly one author is not a phone number
 * (the other is a contact the exporting phone has not saved, so only the person's own name is a
 * name). Anything else, groups included, returns `null`: the wizard asks.
 */
export function suggestMe(authors: readonly PreviewAuthor[], truncated: boolean): string | null {
  if (truncated || authors.length !== 2) return null;
  const named = authors.filter((a) => !a.looksLikePhoneNumber);
  return named.length === 1 ? named[0].name : null;
}

const iso = (a: string, b: string, pick: 'min' | 'max') => ((pick === 'min') === (a <= b) ? a : b);

export async function previewWhatsAppExport(
  deps: { client: Pick<DbClient, 'call'> },
  input: PreviewWhatsAppInput,
  control: PreviewControl = {},
): Promise<ImportPreview> {
  const { signal, onProgress } = control;
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...input.limits };
  const target = input.conversation ?? { mode: 'auto' };
  if (target.mode === 'existing' && !isUuid(target.conversationId)) throw new ImportError('invalid', 'conversationId must be a UUID');
  for (const id of input.profileIds) if (!isUuid(id)) throw new ImportError('invalid', 'profileIds must be UUIDs');
  if (input.dayFirst && input.monthFirst) throw new ImportError('invalid', 'dayFirst and monthFirst cannot both be set');
  signal?.throwIfAborted();

  const draft = createMessageDrafter();
  const fingerprints: string[] = [];
  const authored: string[] = [];
  const authorCounts = new Map<string, number>();
  let authorsTruncated = false;
  const mediaRefs = new Map<string, string>();
  let firstAt = '';
  let lastAt = '';
  let stream;
  try {
    onProgress?.({ phase: 'reading', done: 0 });
    stream = await streamWhatsAppZip(input.zip, input.fileName, {
      dayFirst: input.dayFirst,
      monthFirst: input.monthFirst,
      signal,
      limits: {
        maxEntries: limits.maxEntries,
        maxCentralDirectoryBytes: limits.maxCentralDirectoryBytes,
        maxChatBytes: limits.maxChatBytes,
        maxCompressionRatio: limits.maxCompressionRatio,
      },
    });
    for await (const m of stream.messages) {
      const d = draft(m);
      fingerprints.push(d.fingerprint);
      if (m.type !== 'system') authored.push(d.fingerprint);
      if (fingerprints.length === 1) firstAt = lastAt = m.timestamp_iso;
      else {
        firstAt = iso(firstAt, m.timestamp_iso, 'min');
        lastAt = iso(lastAt, m.timestamp_iso, 'max');
      }
      if (d.author !== '') {
        const seen = authorCounts.get(d.author);
        if (seen !== undefined) authorCounts.set(d.author, seen + 1);
        else if (authorCounts.size < MAX_PREVIEW_AUTHORS) authorCounts.set(d.author, 1);
        else authorsTruncated = true;
      }
      if (m.media !== '') mediaRefs.set(normalizeMediaName(m.media), m.media);
      if (fingerprints.length % READING_REPORT_EVERY === 0) onProgress?.({ phase: 'reading', done: fingerprints.length });
    }
  } catch (cause) {
    signal?.throwIfAborted();
    throw zipProblem(cause);
  }
  if (fingerprints.length === 0) throw new ImportError('invalid-export', 'the export contains no messages');
  onProgress?.({ phase: 'reading', done: fingerprints.length });
  signal?.throwIfAborted();

  const detection = stream.detection;
  const dateFormat: ImportPreview['dateFormat'] = {
    dayFirst: detection?.dayFirst ?? true,
    ambiguous: detection?.ambiguous ?? false,
    ...(detection?.ambiguous && detection.preview ? { preview: detection.preview } : {}),
  };

  const authors: PreviewAuthor[] = [...authorCounts]
    .map(([name, messageCount]) => ({ name, messageCount, looksLikePhoneNumber: looksLikePhoneNumber(name) }))
    .sort((a, b) => b.messageCount - a.messageCount);

  // Media from the central directory: what the ZIP holds, and what the chat refers to that it lacks.
  const kinds: ImportPreview['media']['byKind'] = {};
  let totalCount = 0;
  let totalBytes = 0;
  for (const entry of stream.entries) {
    if (entry.name.endsWith('/') || isChatEntry(entry.name) || isAppleDouble(entry.name)) continue;
    const kind = classifyFromFilename(entryBaseName(entry.name));
    const slot = (kinds[kind] ??= { count: 0, bytes: 0 });
    slot.count++;
    slot.bytes += entry.uncompressedSize;
    totalCount++;
    totalBytes += entry.uncompressedSize;
  }
  const { unresolved } = matchMediaEntries(stream.entries, [...mediaRefs.values()]);
  const missing = new Set(unresolved.map(normalizeMediaName)).size;

  const space = await estimateImport(input.zip, input.storage ?? { usage: null, quota: null }, input.limits);
  signal?.throwIfAborted();

  const sourceKey = chatKeyOf(stream.info.name);
  const base = {
    chatTitle: chatTitleOf(stream.info.name),
    sourceKey,
    messageCount: fingerprints.length,
    firstAt,
    lastAt,
    authors,
    authorsTruncated,
    suggestedMe: suggestMe(authors, authorsTruncated),
    dateFormat,
    rawLines: stream.warnings.length,
    media: { byKind: kinds, totalCount, totalBytes, missing },
    space,
  };
  const isGroup = guessIsGroup(authorsTruncated ? MAX_PREVIEW_AUTHORS + 1 : authorCounts.size);

  // Same order as the import: a genuine date tie is settled before any conversation is looked up.
  if (target.mode === 'auto' && detection?.ambiguous && !detection.overridden) {
    return { ...base, isGroup, duplicates: { status: 'date-format' } };
  }

  let match: { conversationId: string; title: string; storedCount: number } | undefined;
  if (target.mode === 'existing') {
    const known = (await deps.client.call('listConversations')).find((c) => c.id === target.conversationId);
    if (!known) throw new DbError('not-found', 'conversation not found');
    match = { conversationId: known.id, title: known.title, storedCount: known.messageCount };
  } else if (target.mode === 'auto') {
    const found = await matchConversation(deps.client, { sourceKey, profileIds: input.profileIds, authored });
    if (found.kind === 'ambiguous') {
      return { ...base, isGroup, duplicates: { status: 'ambiguous', reason: found.reason, candidates: found.candidates } };
    }
    if (found.kind === 'existing') {
      match = { conversationId: found.conversationId, title: found.title, storedCount: found.messageCount };
    }
  }
  if (!match) return { ...base, isGroup, duplicates: { status: 'new' } };

  let alreadyThere = 0;
  for (let at = 0; at < fingerprints.length; at += MATCH_CHUNK) {
    signal?.throwIfAborted();
    onProgress?.({ phase: 'matching', done: at, total: fingerprints.length });
    const found = await deps.client.call('findExistingFingerprints', {
      conversationId: match.conversationId,
      fingerprints: fingerprints.slice(at, at + MATCH_CHUNK),
    });
    alreadyThere += found.length;
  }
  onProgress?.({ phase: 'matching', done: fingerprints.length, total: fingerprints.length });
  signal?.throwIfAborted();
  return {
    ...base,
    isGroup,
    duplicates: { status: 'existing', ...match, alreadyThere, wouldAdd: fingerprints.length - alreadyThere },
  };
}
