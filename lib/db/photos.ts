import type { BlobRef } from '../domain/library';
import { isSha256Hex, isUuid } from '../domain/library';
import {
  PHOTO_ALBUM_MAX,
  PHOTO_DESCRIPTION_MAX,
  PHOTO_FILE_NAME_MAX,
  codePointLength,
  isPhotoDateSource,
  isPhotoOffset,
  isPhotoKind,
  isTakenAt,
  type NewPhotoItem,
  type PhotoBatch,
  type PhotoItem,
} from '../domain/photo';
import { isMimeType } from '../domain/profile';
import { DbError } from './errors';
import { isReferenced } from './queries';
import { transaction, type SqlDb } from './sql';

/**
 * The photo collection's queries (`docs/formats/photo-library.md`). Everything arrives from outside
 * the type system (a worker message built from an untrusted ZIP), so every field is checked here.
 */

const invalid = (message: string): never => {
  throw new DbError('invalid', message);
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max: number, nonEmpty = false): string {
  if (typeof value !== 'string') return invalid(`${what} must be a string`);
  // Code points, like the importer's own truncation (an emoji-heavy name must not fail the import).
  if (value.length > max * 2 || codePointLength(value) > max) return invalid(`${what} is too long`);
  if (nonEmpty && value.length === 0) return invalid(`${what} must not be empty`);
  return value;
}

/** An imported item as checked: the same fields, known to be well formed. */
function checkItem(raw: unknown): NewPhotoItem {
  const r = record(raw, 'item');
  if (!isSha256Hex(r.sha256)) invalid('item sha256 must be 64 lowercase hex characters');
  if (!isPhotoKind(r.kind)) invalid('item kind must be photo or video');
  if (r.mime !== null && !isMimeType(r.mime)) invalid('item mime must be a type/subtype media type or null');
  if (r.takenAt !== null && !isTakenAt(r.takenAt)) invalid('item takenAt must be a UTC instant or null');
  if (!isPhotoDateSource(r.dateSource)) invalid('item dateSource is not a known date source');
  if ((r.takenAt === null) !== (r.dateSource === 'none')) invalid('item dateSource is none exactly when takenAt is null');
  if (r.takenOffsetMinutes !== null && !isPhotoOffset(r.takenOffsetMinutes)) invalid('item takenOffsetMinutes must be a real UTC offset or null');
  if (r.takenOffsetMinutes !== null && r.dateSource !== 'exif') invalid('item takenOffsetMinutes goes with an exif date');
  const place = (v: unknown, limit: number, what: string): number | null => {
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) return invalid(`item ${what} is out of range`);
    return v;
  };
  const latitude = place(r.latitude, 90, 'latitude');
  const longitude = place(r.longitude, 180, 'longitude');
  if ((latitude === null) !== (longitude === null)) invalid('item latitude and longitude go together');
  return {
    sha256: r.sha256 as string,
    kind: r.kind as NewPhotoItem['kind'],
    mime: r.mime as string | null,
    takenAt: r.takenAt as string | null,
    takenOffsetMinutes: r.takenOffsetMinutes as number | null,
    dateSource: r.dateSource as NewPhotoItem['dateSource'],
    latitude,
    longitude,
    description: text(r.description, 'item description', PHOTO_DESCRIPTION_MAX),
    album: text(r.album, 'item album', PHOTO_ALBUM_MAX),
    fileName: text(r.fileName, 'item fileName', PHOTO_FILE_NAME_MAX, true),
  };
}

export interface ImportPhotoItemsInput {
  batchId: string;
  source: string;
  /** The imported file's name, shown in history. Untrusted. */
  sourceLabel: string;
  now: string;
  /** The media of `items`, already stored by hash. */
  blobs: BlobRef[];
  items: NewPhotoItem[];
}

export interface ImportPhotoItemsResult {
  /** The batch row, or null when nothing was added (an import that adds nothing leaves no history). */
  batchId: string | null;
  added: number;
  /** Items already in the collection (same bytes, same album, same source). */
  skipped: number;
  /** Blobs of `input.blobs` nothing refers to after the import; rows removed, the caller deletes the bytes. */
  unreferencedBlobs: string[];
}

/**
 * Stores one import in a single transaction. Idempotent: an item whose `(sha256, source, album)`
 * is already there is skipped, so importing the same album again, or an overlapping one, adds
 * only what is new. On any failure nothing is stored (not even the batch row).
 */
export function importPhotoItems(db: SqlDb, input: ImportPhotoItemsInput): ImportPhotoItemsResult {
  const params = record(input, 'params');
  if (!isUuid(params.batchId)) invalid('batch id must be a UUID');
  const source = text(params.source, 'source', 40, true);
  const sourceLabel = text(params.sourceLabel, 'sourceLabel', 1000);
  const now = text(params.now, 'now', 40, true);
  if (!Array.isArray(params.blobs) || !Array.isArray(params.items)) return invalid('blobs and items must be lists');
  const blobs = params.blobs.map((raw): BlobRef => {
    const b = record(raw, 'blob');
    if (!isSha256Hex(b.sha256)) invalid('blob sha256 must be 64 lowercase hex characters');
    if (typeof b.size !== 'number' || !Number.isSafeInteger(b.size) || b.size < 0) invalid('blob size must be a non-negative integer');
    if (b.mime !== null && !isMimeType(b.mime)) invalid('blob mime must be a type/subtype media type or null');
    return { sha256: b.sha256 as string, size: b.size as number, mime: b.mime as string | null };
  });
  const known = new Set(blobs.map((b) => b.sha256));
  const items = params.items.map(checkItem);
  for (const item of items) if (!known.has(item.sha256)) invalid('an item refers to media that is not in blobs');
  const batchId = params.batchId as string;

  return transaction(db, () => {
    for (const b of blobs) db.run('INSERT OR IGNORE INTO blobs (sha256, size, mime) VALUES (?, ?, ?)', [b.sha256, b.size, b.mime]);
    db.run('INSERT INTO photo_batches (id, source, source_label, created_at) VALUES (?, ?, ?, ?)', [batchId, source, sourceLabel, now]);
    let added = 0;
    for (const it of items) {
      added += db.run(
        `INSERT OR IGNORE INTO photo_items
           (batch_id, sha256, kind, mime, taken_at, taken_offset_minutes, date_source, latitude, longitude, description, source, album, file_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, it.sha256, it.kind, it.mime, it.takenAt, it.takenOffsetMinutes, it.dateSource, it.latitude, it.longitude, it.description, source, it.album, it.fileName],
      );
    }
    const skipped = items.length - added;
    if (added === 0) db.run('DELETE FROM photo_batches WHERE id = ?', [batchId]);
    else db.run('UPDATE photo_batches SET added_count = ?, skipped_count = ? WHERE id = ?', [added, skipped, batchId]);

    const unreferencedBlobs: string[] = [];
    for (const sha256 of known) {
      if (isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return { batchId: added === 0 ? null : batchId, added, skipped, unreferencedBlobs };
  });
}

export interface UndoPhotoBatchResult {
  /** False when the batch does not exist (already undone): nothing changed. */
  found: boolean;
  removedItems: number;
  /** Blobs nothing refers to any more; rows removed, the caller deletes the bytes. */
  unreferencedBlobs: string[];
}

/**
 * Takes a photo import back: the items it added and the media nothing else uses. A picture the
 * import found already present belongs to the batch that added it and stays. Idempotent.
 */
export function undoPhotoBatch(db: SqlDb, batchId: string): UndoPhotoBatchResult {
  if (!isUuid(batchId)) invalid('batch id must be a UUID');
  return transaction(db, () => {
    if (db.all('SELECT 1 FROM photo_batches WHERE id = ?', [batchId]).length === 0) {
      return { found: false, removedItems: 0, unreferencedBlobs: [] };
    }
    const candidates = db.all<{ sha256: string }>('SELECT DISTINCT sha256 FROM photo_items WHERE batch_id = ?', [batchId]).map((r) => r.sha256);
    const removedItems = db.run('DELETE FROM photo_items WHERE batch_id = ?', [batchId]);
    db.run('DELETE FROM photo_batches WHERE id = ?', [batchId]);
    const unreferencedBlobs: string[] = [];
    for (const sha256 of candidates) {
      if (isReferenced(db, sha256)) continue;
      db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
      unreferencedBlobs.push(sha256);
    }
    return { found: true, removedItems, unreferencedBlobs };
  });
}

export const PHOTO_PAGE_MAX = 500;

export interface ListPhotoItemsInput {
  /** Items with an id above this one (keyset paging in insertion order). */
  afterId?: number;
  /** 1..500. */
  limit: number;
}

interface ItemRow {
  id: number;
  batchId: string;
  sha256: string;
  kind: PhotoItem['kind'];
  mime: string | null;
  takenAt: string | null;
  takenOffsetMinutes: number | null;
  dateSource: PhotoItem['dateSource'];
  latitude: number | null;
  longitude: number | null;
  description: string;
  source: string;
  album: string;
  fileName: string;
}

/** The collection in insertion order, one page at a time. Read-only. */
export function listPhotoItems(db: SqlDb, input: ListPhotoItemsInput): PhotoItem[] {
  const params = record(input, 'params');
  if (typeof params.limit !== 'number' || !Number.isFinite(params.limit)) invalid('limit must be a number');
  if (params.afterId !== undefined && (typeof params.afterId !== 'number' || !Number.isSafeInteger(params.afterId))) invalid('afterId must be an integer');
  const limit = Math.min(Math.max(Math.trunc(params.limit as number), 1), PHOTO_PAGE_MAX);
  return db.all<ItemRow>(
    `SELECT id, batch_id AS batchId, sha256, kind, mime, taken_at AS takenAt, taken_offset_minutes AS takenOffsetMinutes, date_source AS dateSource, latitude, longitude,
            description, source, album, file_name AS fileName
       FROM photo_items WHERE id > ? ORDER BY id LIMIT ?`,
    [(params.afterId as number | undefined) ?? 0, limit],
  );
}

export function countPhotoItems(db: SqlDb): number {
  return db.all<{ n: number }>('SELECT count(*) AS n FROM photo_items')[0].n;
}

/** Photo imports, newest first. */
export function listPhotoBatches(db: SqlDb): PhotoBatch[] {
  return db.all<PhotoBatch>(
    `SELECT id, source, source_label AS sourceLabel, created_at AS createdAt, added_count AS addedCount, skipped_count AS skippedCount
       FROM photo_batches ORDER BY created_at DESC, id DESC`,
  );
}
