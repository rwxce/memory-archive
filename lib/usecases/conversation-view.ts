import { DbError } from '../db/errors';
import {
  isSha256Hex,
  type ConversationBounds,
  type ConversationDay,
  type ConversationMessage,
  type ConversationSummary,
  type MessageSource,
  type Participant,
} from '../domain/library';
import { isMimeType } from '../domain/profile';
import type { BlobStore } from '../storage/blob-store';
import type { LibraryDeps } from './profiles';

/**
 * Reads for the virtualized conversation view. Everything is by position: the view asks for the
 * count, then windows of rows by offset, and jumps by date. Failures are `DbError`s:
 * `not-found` (no such conversation or blob), `invalid` (bad offset, date or hash).
 */

/** Rows the view fetches per window by default; the database caps one window at `MAX_WINDOW`. */
export const WINDOW_SIZE = 100;

export interface ConversationView {
  conversation: ConversationSummary;
  bounds: ConversationBounds;
  participants: Participant[];
}

/** What the view needs to open a conversation. `not-found` when it does not exist. */
export async function openConversationView(deps: LibraryDeps, conversationId: string): Promise<ConversationView> {
  const bounds = await deps.client.call('getConversationBounds', { conversationId });
  const [summaries, participants] = await Promise.all([
    deps.client.call('listConversations'),
    deps.client.call('listParticipants', { conversationId }),
  ]);
  const conversation = summaries.find((c) => c.id === conversationId);
  if (!conversation) throw new DbError('not-found', 'conversation not found');
  return { conversation, bounds, participants };
}

export function countMessages(deps: LibraryDeps, conversationId: string): Promise<number> {
  return deps.client.call('countMessages', { conversationId });
}

/** Messages at positions `offset`..`offset + limit` (chronological; empty past the end). */
export function getMessageWindow(
  deps: LibraryDeps,
  conversationId: string,
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<ConversationMessage[]> {
  return deps.client.call('getMessageWindow', { conversationId, offset, limit });
}

/** Offset of the first message on or after a local date `YYYY-MM-DD`; `null` when all are earlier. */
export function findMessageOffsetByDate(deps: LibraryDeps, conversationId: string, date: string): Promise<number | null> {
  return deps.client.call('findMessageOffsetByDate', { conversationId, date });
}

/** Offset of one message in the conversation (0-based); `null` when it is not in that conversation. */
export function findMessageOffsetById(deps: LibraryDeps, conversationId: string, messageId: number): Promise<number | null> {
  return deps.client.call('findMessageOffsetById', { conversationId, messageId });
}

/** The import (file/label, date) that first added a message; `not-found` if it is not in that conversation. */
export function getMessageSource(deps: LibraryDeps, conversationId: string, messageId: number): Promise<MessageSource> {
  return deps.client.call('getMessageSource', { conversationId, messageId });
}

/** Days that have messages, with counts and first offsets (for the calendar). */
export function listConversationDays(deps: LibraryDeps, conversationId: string): Promise<ConversationDay[]> {
  return deps.client.call('listConversationDays', { conversationId });
}

/** Extension -> media type, for blobs imported without one. Only what a viewer can show. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  pdf: 'application/pdf',
};

/** The media type to show a blob with: the stored one, else guessed from the name, else bytes. */
export function mediaTypeOf(hint: { mime?: string | null; name?: string } = {}): string {
  if (isMimeType(hint.mime)) return hint.mime;
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(hint.name ?? '')?.[1]?.toLowerCase();
  return (ext && Object.hasOwn(MIME_BY_EXTENSION, ext) && MIME_BY_EXTENSION[ext]) || 'application/octet-stream';
}

/**
 * Largest file `readBlob` copies into memory when the store cannot hand out a lazy `File` (OPFS
 * can: then there is no limit, the browser reads from disk as the player or viewer needs it).
 */
export const MAX_IN_MEMORY_MEDIA_BYTES = 256 * 1024 * 1024;

/**
 * One stored blob as a `Blob` typed for display (the UI turns it into an object URL). With a store
 * that provides `file` the result is a lazy view of the stored file, so a long video costs no
 * memory; otherwise the bytes are read into memory (ask for one item at a time, as it scrolls into
 * view, never the lot) and a file over `MAX_IN_MEMORY_MEDIA_BYTES` is refused before reading.
 * `invalid` for a malformed hash, `not-found` when the store has no such blob, `too-large` above
 * the limit on the in-memory path.
 */
export async function readBlob(
  deps: { blobStore: BlobStore },
  sha256: string,
  hint: { mime?: string | null; name?: string } = {},
): Promise<Blob> {
  if (!isSha256Hex(sha256)) throw new DbError('invalid', 'sha256 must be 64 lowercase hex characters');
  const type = mediaTypeOf(hint);
  const file = await deps.blobStore.file?.(sha256);
  if (file) return new Blob([file], { type });
  const size = await deps.blobStore.size(sha256);
  if (size === undefined) throw new DbError('not-found', 'media is not in the blob store');
  if (size > MAX_IN_MEMORY_MEDIA_BYTES) throw new DbError('too-large', 'media is too large to open');
  const stream = await deps.blobStore.open(sha256);
  if (!stream) throw new DbError('not-found', 'media is not in the blob store');
  const bytes = await new Response(stream).arrayBuffer();
  return new Blob([bytes], { type });
}
