import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import { ArchiveError, MAX_COMPRESSION_RATIO } from '../exporters/archive/format';
import type { ImportCandidate } from '../db/queries';
import { createFingerprinter, normalizeAuthor } from '../domain/fingerprint';
import { isUuid, type BlobRef, type NewMessage } from '../domain/library';
import { chatKeyOf, chatTitleOf } from '../importers/whatsapp/chat';
import type { Message } from '../importers/whatsapp/types';
import { parseWhatsAppZip } from '../importers/whatsapp/import';
import { matchMediaEntries, mimeFromFileName, normalizeMediaName } from '../importers/whatsapp/media';
import { asImportArchive } from '../importers/whatsapp/text-export';
import { openZipEntry, ZipLimitError } from '../importers/whatsapp/zip';
import { withArchiveGuard } from './archive-guard';
import { newIdOf, nowOf, type ProfileDeps } from './profiles';

/**
 * Importing a WhatsApp export into the library, undoing an import, and sweeping media that no
 * database row refers to. All three take the archive busy guard (`withArchiveGuard`): a restore,
 * a backup, another import or a sweep running at the same time is refused with `ArchiveError`
 * `busy`.
 *
 * Order of an import, and why it is safe to interrupt at any point:
 *   1. read: parse the ZIP (no side effect);
 *   2. decide the conversation (reads only; an unclear match returns `ambiguous`, nothing written);
 *   3. media: stream each needed file into the blob store, hashed on the way. Bytes land in the
 *      store BEFORE the database knows them. Interrupted here, the database is untouched and the
 *      blobs written so far are removed (best effort); if even that cannot run (a crash), they are
 *      orphans that `sweepOrphanBlobs` removes;
 *   4. save: ONE database transaction writes the batch, the conversation (when new), the
 *      participants and the messages. It commits whole or not at all.
 *
 * Known limits (also in docs/blueprint.md): the transcript is parsed in memory (`maxChatBytes`
 * 256 MiB is far too high for a phone) and all messages cross the worker boundary in ONE request;
 * a browser default has to be lower and requests chunked (follow-up). Undoing the batch that
 * created a conversation removes the messages a later, overlapping export re-contained (they were
 * stored by the first batch); undoing the first of several batches can leave an empty conversation.
 */

export interface ImportLimits {
  /** Entries a ZIP may declare. */
  maxEntries: number;
  /** Declared size of the central directory. */
  maxCentralDirectoryBytes: number;
  /** Uncompressed size of `_chat.txt`. */
  maxChatBytes: number;
  /** Uncompressed size of one media file. */
  maxMediaBytes: number;
  /** Declared uncompressed / compressed size of a deflated entry (zip-bomb guard, same as restore). */
  maxCompressionRatio: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxEntries: 100_000,
  maxCentralDirectoryBytes: 32 * 1024 * 1024,
  maxChatBytes: 256 * 1024 * 1024,
  maxMediaBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
};

export type ImportErrorCode =
  | 'invalid-export'
  | 'limit-exceeded'
  | 'unknown-author'
  | 'invalid'
  /** The import worker crashed or could not start (see `import-client.ts`): the archive is unchanged or holds the whole batch, never half of it. */
  | 'worker-failed';

/** A problem with the import request or the file. Messages never contain chat text or names. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
    this.code = code;
  }
}

export type ImportPhase = 'reading' | 'media' | 'saving';

export interface ImportProgress {
  phase: ImportPhase;
  done: number;
  total: number;
  /** `media` phase only: uncompressed bytes copied so far (also within a big file) and in total. */
  bytes?: number;
  totalBytes?: number;
}

/** At most this often within one big file (`media` progress by bytes); file boundaries always report. */
const BYTES_PROGRESS_INTERVAL_MS = 200;

/**
 * Which conversation the messages go to.
 * - `auto` (default): the one chat this export is the continuation of, or a new one. Rule below.
 * - `new`: always a new conversation.
 * - `existing`: merge into this conversation (the caller's explicit choice, e.g. after `ambiguous`).
 *
 * The `auto` rule is conservative: it only looks among conversations of the same source filed
 * under one of `profileIds` (or under no profile when the list is empty). A name is never enough
 * to merge: two different chats can share a name (and every export of a phone can be called
 * `chat.zip`), so a merge also needs proof that it is the same chat, namely at least one of up
 * to 200 sampled messages of this export already stored in it. A full-history re-export always
 * has that proof.
 *   1. Exactly one has the same chat key (`chatKeyOf`: the export's chat name without the
 *      language-specific prefix, case-folded; stored once, so renaming a conversation does not
 *      break it) AND already holds a sampled message: merge into it.
 *   2. Exactly one has the key but none of the sampled messages: the lookup is repeated once
 *      with ALL of the export's messages (a newer export may share only a few); if still none:
 *      `ambiguous` (`same-title-no-overlap`): probably a different chat with the same name.
 *   3. Several have the key: `ambiguous` (`same-title`).
 *   4. None has the key but one or more hold sampled messages (the chat was renamed on the
 *      phone, or exported in another language): `ambiguous` (`overlap`).
 *   5. Otherwise: a new conversation.
 * The same chat filed under another profile is a different conversation by design. An export
 * made of system messages only has nothing to sample, so it can never be merged by `auto`.
 */
export type ConversationTarget =
  | { mode: 'auto' }
  | { mode: 'new' }
  | { mode: 'existing'; conversationId: string };

export interface ImportWhatsAppInput {
  /** A WhatsApp export ZIP, or a bare `.txt` export made without media (decided by content, not by name). */
  zip: Blob;
  /** Base name of the file, e.g. `WhatsApp Chat - Ana.zip` or `.txt` (untrusted; the chat name comes from it). */
  fileName: string;
  /** Profiles the conversation is filed under when it is created; ignored when merging. */
  profileIds: string[];
  conversation?: ConversationTarget;
  /** The author the user said is themselves, as it appears in the chat; null when not chosen. */
  meAuthor: string | null;
  /** Overrides the group guess (more than two distinct authors). Only used when creating. */
  isGroup?: boolean;
  /**
   * `skipVideos`: keep the video messages but store no video bytes. Not reversible by importing
   * again: a re-import only adds messages that are new, it never fills in media a message was
   * stored without (skipped videos, files missing from the ZIP). Getting the bytes later means
   * undoing the batch and importing again (follow-up: backfill media on re-import).
   */
  options?: { skipVideos?: boolean };
  /**
   * Read ambiguous dates (`03/04/2026`) as day-first / month-first. The order is decided from
   * the whole transcript: one date with a component >= 13 anywhere settles it. Only when every
   * date reads both ways does `auto` stop with `ambiguous` / `date-format` (nothing written,
   * both readings of the first date in `datePreview`); pass the right one then, for every export
   * of that chat. Both flags together are `invalid`. With an explicit conversation target
   * (`new` / `existing`) a genuine tie is not refused: the guess is reported in `dateFormat`.
   */
  dayFirst?: boolean;
  monthFirst?: boolean;
  /** Aborting before the save step leaves the archive exactly as it was. */
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  limits?: Partial<ImportLimits>;
}

export interface ImportSummary {
  /** Messages stored by this import. */
  added: number;
  /** Messages already in the conversation: not stored again. */
  alreadyThere: number;
  /** Media files stored for the first time. */
  mediaAdded: number;
  /** Media files not stored: their message was already there, or identical bytes were already stored. */
  mediaSkipped: number;
  /** Media a message refers to but the ZIP does not contain: the message is kept without its file. */
  mediaMissing: number;
  /** Videos left out because of `skipVideos`: the messages are kept without their file. */
  videosSkipped: number;
  /**
   * Lines that looked like a message start but whose date is unusable under the chosen day/month
   * order (31/02, month 13, out-of-range year): kept as text of the previous message and counted
   * here, never dropped silently. One that precedes the first message has nothing to attach to:
   * it is counted but its text is not stored.
   */
  rawLines: number;
}

/** How the export's dates were read. `ambiguous`: it was a guess (see `ImportWhatsAppInput.dayFirst`). */
export interface DateFormat {
  dayFirst: boolean;
  ambiguous: boolean;
}

export type ImportResult =
  | {
      status: 'imported';
      dateFormat: DateFormat;
      batchId: string;
      conversationId: string;
      createdConversation: boolean;
      summary: ImportSummary;
    }
  | {
      status: 'ambiguous';
      dateFormat: DateFormat;
      reason: 'same-title' | 'same-title-no-overlap' | 'overlap' | 'date-format';
      /** `date-format` only: the first ambiguous date read both ways (`YYYY-MM-DD`). */
      datePreview?: { dayFirst: string; monthFirst: string };
      /** Choose one with `{ mode: 'existing' }`, or `{ mode: 'new' }`. */
      candidates: ImportCandidate[];
    };

const SAMPLE_SIZE = 200;
const SOURCE = 'whatsapp';

/** Evenly spaced picks, so a newer export's overlap with an older one shows wherever it is. */
function sample<T>(items: readonly T[], size: number): T[] {
  if (items.length <= size) return [...items];
  return Array.from({ length: size }, (_, i) => items[Math.floor((i * items.length) / size)]);
}

/** More than two distinct authors: a group. The import and its preview use this one rule. */
export const guessIsGroup = (distinctAuthors: number): boolean => distinctAuthors > 2;

/**
 * A message as the import stores it, in transcript order: the normalized author (`''` for a
 * system message), the occurrence index within its minute and the fingerprint. The import and
 * its preview both build their fingerprints here, so a preview counts exactly what the import
 * will find.
 */
export function createMessageDrafter(): (m: Message) => { author: string; ordinal: number; fingerprint: string } {
  const nextFingerprint = createFingerprinter();
  const ordinals = new Map<string, number>();
  return (m) => {
    const author = m.type === 'system' ? '' : normalizeAuthor(m.author);
    const ordinal = ordinals.get(m.timestamp_iso) ?? 0;
    ordinals.set(m.timestamp_iso, ordinal + 1);
    return {
      author,
      ordinal,
      fingerprint: nextFingerprint({ sentAt: m.timestamp_iso, author, type: m.type, text: m.text, mediaName: m.media }),
    };
  };
}

export type ConversationMatch =
  | { kind: 'existing'; conversationId: string; title: string; messageCount: number }
  | { kind: 'new' }
  | { kind: 'ambiguous'; reason: 'same-title' | 'same-title-no-overlap' | 'overlap'; candidates: ImportCandidate[] };

/**
 * The `auto` rule documented on `ConversationTarget`, as one function (reads only): the import
 * acts on its answer and the preview reports it. `authored`: fingerprints of the export's
 * non-system messages.
 */
export async function matchConversation(
  client: Pick<DbClient, 'call'>,
  input: { sourceKey: string; profileIds: string[]; authored: string[] },
): Promise<ConversationMatch> {
  const lookup = (sampleFingerprints: string[]) =>
    client.call('findImportCandidates', { source: SOURCE, sourceKey: input.sourceKey, profileIds: input.profileIds, sampleFingerprints });
  let found = await lookup(sample(input.authored, SAMPLE_SIZE));
  // A newer export can share only a handful of messages with what is stored, and a sample can
  // miss them: before calling a same-name chat a different one, look for ALL of its messages.
  if (found.keyed.length === 1 && found.keyed[0].overlap === 0) found = await lookup(input.authored);
  if (found.keyed.length > 1) return { kind: 'ambiguous', reason: 'same-title', candidates: found.keyed };
  if (found.keyed.length === 1 && found.keyed[0].overlap === 0) {
    return { kind: 'ambiguous', reason: 'same-title-no-overlap', candidates: found.keyed };
  }
  if (found.keyed.length === 0 && found.overlapping.length > 0) {
    return { kind: 'ambiguous', reason: 'overlap', candidates: found.overlapping };
  }
  if (found.keyed.length === 1) {
    const [only] = found.keyed;
    return { kind: 'existing', conversationId: only.id, title: only.title, messageCount: only.messageCount };
  }
  return { kind: 'new' };
}

/**
 * The entry's bytes pass through unchanged. Aborting the signal stops the copy into the store, and
 * a failure of the ZIP itself (a size bomb, a damaged entry) is recorded in `failure`, so the
 * import can tell "this file is bad" from "the store failed" whatever the store wraps it in.
 */
function entryStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  failure: { error?: unknown },
  onBytes?: (n: number) => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else {
          controller.enqueue(chunk.value);
          onBytes?.(chunk.value.length);
        }
      } catch (error) {
        if (!signal?.aborted) failure.error ??= error;
        reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** A ZIP problem as the typed error the caller can act on. */
export function zipProblem(cause: unknown): ImportError {
  if (cause instanceof ZipLimitError) return new ImportError('limit-exceeded', 'the export is larger than allowed', { cause });
  return new ImportError('invalid-export', 'this file is not a readable WhatsApp export', { cause });
}

/** Removes stored blobs (and their cached thumbnails); a blob that cannot be removed now is left for the orphan sweep. */
export async function deleteBlobs(stores: Pick<ProfileDeps, 'blobStore' | 'thumbStore'>, hashes: Iterable<string>): Promise<number> {
  let removed = 0;
  for (const sha256 of hashes) {
    // The cache is derived: its failure never blocks removing the blob (and is capped anyway).
    await stores.thumbStore?.delete(sha256).catch(() => undefined);
    try {
      if (await stores.blobStore.delete(sha256)) removed++;
    } catch {
      // Left behind as an orphan: `sweepOrphanBlobs` removes it.
    }
  }
  return removed;
}

/** A failure after which the database definitely did not commit (not a lost connection). */
const isDefiniteDbFailure = (error: unknown) =>
  error instanceof DbError && error.code !== 'unavailable' && error.code !== 'closed';

export function importWhatsAppExport(deps: ProfileDeps, input: ImportWhatsAppInput): Promise<ImportResult> {
  return withArchiveGuard(deps.blobStore, () => importNow(deps, input), deps.lock);
}

async function importNow(deps: ProfileDeps, input: ImportWhatsAppInput): Promise<ImportResult> {
  const { signal, onProgress } = input;
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...input.limits };
  const target = input.conversation ?? { mode: 'auto' };
  if (target.mode === 'existing' && !isUuid(target.conversationId)) throw new ImportError('invalid', 'conversationId must be a UUID');
  for (const id of input.profileIds) if (!isUuid(id)) throw new ImportError('invalid', 'profileIds must be UUIDs');
  if (input.dayFirst && input.monthFirst) throw new ImportError('invalid', 'dayFirst and monthFirst cannot both be set');
  signal?.throwIfAborted();

  // 1. read
  onProgress?.({ phase: 'reading', done: 0, total: 1 });
  let parsed;
  let zip: Blob;
  try {
    // A bare `.txt` export (no media) is read as a one-entry archive.
    zip = await asImportArchive(input.zip, limits.maxChatBytes);
    parsed = await parseWhatsAppZip(zip, input.fileName, {
      dayFirst: input.dayFirst,
      monthFirst: input.monthFirst,
      limits: {
        maxEntries: limits.maxEntries,
        maxCentralDirectoryBytes: limits.maxCentralDirectoryBytes,
        maxChatBytes: limits.maxChatBytes,
        maxCompressionRatio: limits.maxCompressionRatio,
      },
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw zipProblem(cause);
  }
  if (parsed.messages.length === 0) throw new ImportError('invalid-export', 'the export contains no messages');
  onProgress?.({ phase: 'reading', done: 1, total: 1 });
  signal?.throwIfAborted();
  const dateFormat: DateFormat = { dayFirst: parsed.detection?.dayFirst ?? true, ambiguous: parsed.detection?.ambiguous ?? false };

  const draft = createMessageDrafter();
  const authors = new Set<string>();
  const drafts = parsed.messages.map((m) => {
    const d = draft(m);
    if (d.author !== '') authors.add(d.author);
    return { message: m, ...d };
  });
  const meAuthor = input.meAuthor === null ? null : normalizeAuthor(input.meAuthor);
  if (meAuthor !== null && !authors.has(meAuthor)) {
    throw new ImportError('unknown-author', 'the chosen "me" is not an author of this chat');
  }

  // A genuine tie (every date reads both ways): reading it wrongly changes every fingerprint, so
  // `auto` asks before writing anything.
  if (target.mode === 'auto' && parsed.detection?.ambiguous && !parsed.detection.overridden) {
    return { status: 'ambiguous', dateFormat, reason: 'date-format', candidates: [], datePreview: parsed.detection.preview };
  }

  // 2. which conversation
  const title = chatTitleOf(parsed.info.name);
  const sourceKey = chatKeyOf(parsed.info.name);
  let conversationId: string;
  let createdConversation = false;
  if (target.mode === 'existing') {
    const known = await deps.client.call('listConversations');
    if (!known.some((c) => c.id === target.conversationId)) throw new DbError('not-found', 'conversation not found');
    conversationId = target.conversationId;
  } else if (target.mode === 'new') {
    conversationId = newIdOf(deps);
    createdConversation = true;
  } else {
    const match = await matchConversation(deps.client, {
      sourceKey,
      profileIds: input.profileIds,
      authored: drafts.filter((d) => d.message.type !== 'system').map((d) => d.fingerprint),
    });
    if (match.kind === 'ambiguous') return { status: 'ambiguous', dateFormat, reason: match.reason, candidates: match.candidates };
    if (match.kind === 'existing') conversationId = match.conversationId;
    else {
      conversationId = newIdOf(deps);
      createdConversation = true;
    }
  }
  signal?.throwIfAborted();

  // 3. media: which files are needed, then stream them into the store
  const alreadyThere = createdConversation
    ? new Set<string>()
    : new Set(
        await deps.client.call('findExistingFingerprints', {
          conversationId,
          fingerprints: drafts.filter((d) => d.message.media !== '').map((d) => d.fingerprint),
        }),
      );
  const mediaDrafts = drafts.filter((d) => d.message.media !== '');
  const { matches, unresolved } = matchMediaEntries(parsed.entries, [...new Set(mediaDrafts.map((d) => d.message.media))], parsed.chatEntry);
  const matchByName = new Map(matches.map((m) => [normalizeMediaName(m.ref), m]));
  const needed = new Map<string, (typeof matches)[number]>();
  let videosSkipped = 0;
  let mediaSkipped = 0;
  for (const [name, match] of matchByName) {
    const users = mediaDrafts.filter((d) => normalizeMediaName(d.message.media) === name);
    const fresh = users.filter((d) => !alreadyThere.has(d.fingerprint));
    if (fresh.length === 0) mediaSkipped++;
    else if (input.options?.skipVideos && fresh.every((d) => d.message.type === 'video')) videosSkipped++;
    else needed.set(name, match);
  }
  const mediaMissing = new Set(unresolved.map(normalizeMediaName)).size;

  const stored = new Set(await deps.blobStore.list());
  const written: string[] = [];
  const blobByName = new Map<string, BlobRef>();
  let mediaAdded = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  const totalBytes = [...needed.values()].reduce((sum, m) => sum + m.entry.uncompressedSize, 0);
  const reportMedia = () => {
    lastReport = Date.now();
    onProgress?.({ phase: 'media', done, total: needed.size, bytes, totalBytes });
  };
  // Byte reports within a file are throttled; file boundaries always report (and restart the clock).
  const onBytes = (n: number) => {
    bytes += n;
    if (Date.now() - lastReport >= BYTES_PROGRESS_INTERVAL_MS) reportMedia();
  };
  let saving = false;
  const entryFailure: { error?: unknown } = {};
  try {
    for (const [name, match] of needed) {
      signal?.throwIfAborted();
      reportMedia();
      if (match.entry.uncompressedSize > limits.maxMediaBytes) {
        throw new ImportError('limit-exceeded', 'a media file is too large; import without videos to skip the biggest ones');
      }
      const info = await deps.blobStore.put(entryStream(openZipEntry(zip, match.entry), signal, entryFailure, onBytes));
      blobByName.set(name, { sha256: info.sha256, size: info.size, mime: mimeFromFileName(match.fileName) });
      if (stored.has(info.sha256)) mediaSkipped++;
      else {
        stored.add(info.sha256);
        written.push(info.sha256);
        mediaAdded++;
      }
      done++;
    }
    reportMedia();
    signal?.throwIfAborted();

    // 4. save, in one transaction
    onProgress?.({ phase: 'saving', done: 0, total: drafts.length });
    const messages: NewMessage[] = drafts.map((d) => {
      const blob = d.message.media === '' || alreadyThere.has(d.fingerprint) ? undefined : blobByName.get(normalizeMediaName(d.message.media));
      return {
        fingerprint: d.fingerprint,
        sentAt: d.message.timestamp_iso,
        ordinal: d.ordinal,
        type: d.message.type,
        participantName: d.author === '' ? null : d.author,
        body: d.message.text,
        mediaSha256: blob?.sha256 ?? null,
        mediaName: d.message.media,
      };
    });
    const batchId = newIdOf(deps);
    saving = true;
    const result = await deps.client.call('importMessages', {
      batchId,
      conversationId,
      source: SOURCE,
      sourceLabel: input.fileName,
      now: nowOf(deps),
      blobs: [...new Map([...blobByName.values()].map((b) => [b.sha256, b])).values()],
      messages,
      meAuthor,
      ...(createdConversation
        ? { newConversation: { title, sourceKey, isGroup: input.isGroup ?? guessIsGroup(authors.size), profileIds: input.profileIds } }
        : {}),
    });
    onProgress?.({ phase: 'saving', done: drafts.length, total: drafts.length });

    // Committed. Bytes of media nothing refers to (a race the pre-check could not see) go away.
    const unreferenced = new Set(result.unreferencedBlobs);
    await deleteBlobs(deps, unreferenced);
    const wasted = written.filter((h) => unreferenced.has(h)).length;
    return {
      status: 'imported',
      dateFormat,
      batchId,
      conversationId,
      createdConversation,
      summary: {
        added: result.added,
        alreadyThere: result.skipped,
        mediaAdded: mediaAdded - wasted,
        mediaSkipped: mediaSkipped + wasted,
        mediaMissing,
        videosSkipped,
        rawLines: parsed.warnings.length,
      },
    };
  } catch (error) {
    // Nothing was committed (before the save step, or the database refused): the bytes written
    // by this run are unreferenced. A lost connection is ambiguous, so those stay for the sweep.
    if (!saving || isDefiniteDbFailure(error)) await deleteBlobs(deps, written);
    if (signal?.aborted && !saving) throw signal.reason;
    if (entryFailure.error !== undefined && !signal?.aborted) throw zipProblem(entryFailure.error);
    throw error;
  }
}

export interface UndoImportResult {
  /** False when the batch does not exist (already undone): nothing changed. */
  found: boolean;
  removedMessages: number;
  removedConversation: boolean;
  /** Media files deleted because nothing else refers to them. */
  removedMedia: number;
}

/**
 * Takes an import back: its messages, what only it brought (participants, the conversation it
 * created once empty) and the media nothing else uses. Media shared with another import,
 * conversation or a profile photo stays. One database transaction, then the unreferenced bytes
 * are deleted; a crash in between leaves orphans for `sweepOrphanBlobs`. Safe to repeat.
 */
export function undoImportBatch(deps: ProfileDeps, batchId: string): Promise<UndoImportResult> {
  return withArchiveGuard(
    deps.blobStore,
    async () => {
      const result = await deps.client.call('undoImportBatch', { batchId });
      const removedMedia = await deleteBlobs(deps, result.unreferencedBlobs);
      return {
        found: result.found,
        removedMessages: result.removedMessages,
        removedConversation: result.removedConversation,
        removedMedia,
      };
    },
    deps.lock,
  );
}

/**
 * Deletes stored media that no database row refers to: what an import interrupted by a crash
 * left behind. Never deletes a blob the database refers to (messages or a profile photo).
 *
 * What is guaranteed: it runs under the archive busy guard (and the cross-tab lock when
 * `deps.lock` is given), so it never overlaps an import, undo, backup, restore or a profile write
 * that carries a photo. What is not: a photo blob stored by the UI but not yet saved with its
 * profile looks like an orphan, so do not sweep while a photo is being chosen. Nothing calls
 * this directly at start-up: `openLibrary` runs `sweepLeftovers`, which adds the blob store's temp files.
 */
export function sweepOrphanBlobs(deps: Pick<ProfileDeps, 'client' | 'blobStore' | 'thumbStore' | 'lock'>): Promise<{ removed: number }> {
  return withArchiveGuard(
    deps.blobStore,
    async () => ({ removed: await removeOrphans(deps) }),
    deps.lock,
  );
}

/** Thumbnails whose photo is no longer stored (a crash between the two deletions, an older run): dropped. Never throws. */
async function removeOrphanThumbnails(deps: Pick<ProfileDeps, 'blobStore' | 'thumbStore'>): Promise<void> {
  if (!deps.thumbStore) return;
  try {
    const stored = new Set(await deps.blobStore.list());
    for (const sha256 of await deps.thumbStore.list()) if (!stored.has(sha256)) await deps.thumbStore.delete(sha256);
  } catch {
    // A cache: the next sweep tries again.
  }
}

async function removeOrphans(deps: Pick<ProfileDeps, 'client' | 'blobStore' | 'thumbStore'>): Promise<number> {
  const known = new Set(await deps.client.call('listBlobHashes'));
  const orphans = (await deps.blobStore.list()).filter((sha256) => !known.has(sha256));
  const removed = await deleteBlobs(deps, orphans);
  await removeOrphanThumbnails(deps);
  return removed;
}

/**
 * The library's open-time cleanup: the blob store's abandoned temp files AND the orphan blobs,
 * together, under the archive busy guard and the cross-tab lock. Both deletions are only safe
 * when no import is writing (its temp files and not-yet-committed blobs look abandoned), which
 * the lock proves across tabs and workers and the guard proves in this tab.
 *
 * Skips (resolves `{ ran: false }`, nothing deleted) when it cannot prove that: another tab or
 * an import worker holds the lock, another archive operation runs in this tab, or there is no
 * lock to take (a browser without Web Locks). Any other failure rejects.
 */
export async function sweepLeftovers(
  deps: Pick<ProfileDeps, 'client' | 'blobStore' | 'thumbStore' | 'lock'>,
): Promise<{ ran: false } | { ran: true; removed: number }> {
  if (!deps.lock) return { ran: false };
  try {
    return await withArchiveGuard(
      deps.blobStore,
      async () => {
        await deps.blobStore.sweepTemp?.();
        return { ran: true as const, removed: await removeOrphans(deps) };
      },
      deps.lock,
    );
  } catch (error) {
    if (error instanceof ArchiveError && error.code === 'busy') return { ran: false };
    throw error;
  }
}
