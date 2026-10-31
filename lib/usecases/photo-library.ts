import type { BlobRef } from '../domain/library';
import { PHOTO_SOURCE_TAKEOUT, truncateCodePoints, type NewPhotoItem, type PhotoBatch, type PhotoItem } from '../domain/photo';
import { TakeoutError } from '../importers/takeout/paths';
import { readTakeoutZip, type TakeoutLimits } from '../importers/takeout/read';
import { openZipEntry, ZipLimitError } from '../importers/whatsapp/zip';
import { withArchiveGuard } from './archive-guard';
import { BYTES_PROGRESS_INTERVAL_MS, deleteBlobs, entryStream, isDefiniteDbFailure, type ImportProgress } from './import';
import { newIdOf, nowOf, type ProfileDeps } from './profiles';

/*
 * The photo collection (`docs/formats/photo-library.md`): importing a Google Photos Takeout album,
 * undoing that import, and reading the collection. No screen calls this yet.
 *
 * Order of an import, and why it is safe to interrupt at any point (same as a chat import):
 *   1. read the ZIP's layout and sidecars (no side effect);
 *   2. media: stream each picture and video into the blob store, hashed on the way. Bytes land in
 *      the store BEFORE the database knows them. Interrupted here, the database is untouched and
 *      the blobs written so far are removed (best effort); after a crash they are orphans that
 *      `sweepOrphanBlobs` removes;
 *   3. save: ONE database transaction writes the batch and the items. It commits whole or not at all.
 *
 * Known limits: every item crosses the worker boundary in one request (bounded by the entry
 * limit; 100,000 items are a few tens of MB); re-importing the same ZIP re-reads and re-hashes
 * its media (nothing is stored twice, but the work is done) because the identity of a picture is
 * the hash of its bytes.
 */

export type TakeoutImportPhase = ImportProgress['phase'];
export type TakeoutImportProgress = ImportProgress;

export interface ImportTakeoutAlbumInput {
  /** A Google Photos Takeout ZIP: one album, several, or a whole library. */
  zip: Blob;
  /** Base name of the file, shown in the import history (untrusted). */
  fileName: string;
  /** Aborting before the save step leaves the archive exactly as it was. */
  signal?: AbortSignal;
  onProgress?: (progress: TakeoutImportProgress) => void;
  limits?: Partial<TakeoutLimits>;
}

export interface TakeoutImportSummary {
  /** Items stored by this import. */
  added: number;
  /** Items already in the collection (same bytes in the same album): not stored again. */
  alreadyThere: number;
  /** The same bytes twice in one album of this ZIP: stored once. */
  duplicatesInFile: number;
  /** Media files written to the store for the first time (a picture also in another album, or already stored, is reused). */
  mediaAdded: number;
  /** Items of this ZIP (new or not) that carry no date taken: no sidecar, or an unusable one. */
  withoutDate: number;
  /** Files in the ZIP that are not pictures, videos or metadata (the HTML index, other file types). */
  ignoredFiles: number;
  /** Sidecars that were too large or not valid JSON. */
  unusableSidecars: number;
  /** Pictures and videos above the size limit, skipped. */
  tooLarge: number;
}

export interface TakeoutImportResult {
  /** Null when the import added nothing (no history row is left behind). */
  batchId: string | null;
  summary: TakeoutImportSummary;
}

/**
 * Imports the pictures and videos of a Takeout ZIP into the photo collection. Not assigned to any
 * profile. All or nothing, and idempotent: the same ZIP again, or one that overlaps, adds only what
 * is new. Rejects with `TakeoutError` (`invalid-takeout`, `unsafe-path`, `limit-exceeded`),
 * `ArchiveError` (`busy`) or `DbError`; an abort rejects with the signal's reason.
 */
export function importTakeoutAlbum(deps: ProfileDeps, input: ImportTakeoutAlbumInput): Promise<TakeoutImportResult> {
  return withArchiveGuard(deps.blobStore, () => importNow(deps, input), deps.lock);
}

const zipProblem = (cause: unknown): TakeoutError =>
  cause instanceof TakeoutError
    ? cause
    : cause instanceof ZipLimitError
      ? new TakeoutError('limit-exceeded', 'a file in the archive is larger than allowed', { cause })
      : new TakeoutError('invalid-takeout', 'this file is not a readable Takeout archive', { cause });

async function importNow(deps: ProfileDeps, input: ImportTakeoutAlbumInput): Promise<TakeoutImportResult> {
  const { signal, onProgress } = input;
  signal?.throwIfAborted();

  // 1. read
  onProgress?.({ phase: 'reading', done: 0, total: 1 });
  let plan;
  try {
    plan = await readTakeoutZip(input.zip, input.limits);
  } catch (cause) {
    signal?.throwIfAborted();
    throw zipProblem(cause);
  }
  onProgress?.({ phase: 'reading', done: 1, total: 1 });
  signal?.throwIfAborted();

  // 2. media
  const stored = new Set(await deps.blobStore.list());
  const written: string[] = [];
  const blobs = new Map<string, BlobRef>();
  const items = new Map<string, NewPhotoItem>();
  let duplicatesInFile = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  const totalBytes = plan.items.reduce((sum, i) => sum + i.entry.uncompressedSize, 0);
  const reportMedia = () => {
    lastReport = Date.now();
    onProgress?.({ phase: 'media', done, total: plan.items.length, bytes, totalBytes });
  };
  const onBytes = (n: number) => {
    bytes += n;
    if (Date.now() - lastReport >= BYTES_PROGRESS_INTERVAL_MS) reportMedia();
  };
  let saving = false;
  const entryFailure: { error?: unknown } = {};
  try {
    for (const planned of plan.items) {
      signal?.throwIfAborted();
      reportMedia();
      const info = await deps.blobStore.put(entryStream(openZipEntry(input.zip, planned.entry), signal, entryFailure, onBytes));
      if (!stored.has(info.sha256)) {
        stored.add(info.sha256);
        written.push(info.sha256);
      }
      blobs.set(info.sha256, { sha256: info.sha256, size: info.size, mime: planned.mime });
      const key = `${info.sha256}\n${planned.album}`;
      const existing = items.get(key);
      if (existing) {
        duplicatesInFile++;
        // The same picture twice in one album: keep the richer metadata, whichever copy has it.
        existing.takenAt ??= planned.metadata?.takenAt ?? null;
        if (existing.latitude === null && planned.metadata?.latitude != null && planned.metadata.longitude != null) {
          existing.latitude = planned.metadata.latitude;
          existing.longitude = planned.metadata.longitude;
        }
        if (existing.description === '') existing.description = planned.metadata?.description ?? '';
      } else {
        items.set(key, {
          sha256: info.sha256,
          kind: planned.kind,
          mime: planned.mime,
          takenAt: planned.metadata?.takenAt ?? null,
          latitude: planned.metadata?.latitude ?? null,
          longitude: planned.metadata?.longitude ?? null,
          description: planned.metadata?.description ?? '',
          album: planned.album,
          fileName: planned.fileName,
        });
      }
      done++;
    }
    reportMedia();
    signal?.throwIfAborted();

    // 3. save, in one transaction
    onProgress?.({ phase: 'saving', done: 0, total: items.size });
    saving = true;
    const batchId = newIdOf(deps);
    const result = await deps.client.call('importPhotoItems', {
      batchId,
      source: PHOTO_SOURCE_TAKEOUT,
      sourceLabel: truncateCodePoints(input.fileName, 1000),
      now: nowOf(deps),
      blobs: [...blobs.values()],
      items: [...items.values()],
    });
    onProgress?.({ phase: 'saving', done: items.size, total: items.size });

    // Committed. Bytes nothing refers to any more (every item was already there) go away.
    const unreferenced = new Set(result.unreferencedBlobs);
    await deleteBlobs(deps, unreferenced);
    const wasted = written.filter((h) => unreferenced.has(h)).length;
    return {
      batchId: result.batchId,
      summary: {
        added: result.added,
        alreadyThere: result.skipped,
        duplicatesInFile,
        mediaAdded: written.length - wasted,
        withoutDate: [...items.values()].filter((i) => i.takenAt === null).length,
        ignoredFiles: plan.stats.ignored,
        unusableSidecars: plan.stats.unusableSidecars,
        tooLarge: plan.stats.tooLarge,
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

export interface UndoPhotoImportResult {
  /** False when the batch does not exist (already undone): nothing changed. */
  found: boolean;
  removedItems: number;
  /** Media files deleted because nothing else refers to them. */
  removedMedia: number;
}

/**
 * Takes a photo import back: the items it added and the media nothing else uses (media shared with
 * a chat, a profile photo or an item of another import stays). One database transaction, then the
 * unreferenced bytes are deleted; a crash in between leaves orphans for `sweepOrphanBlobs`.
 */
export function undoPhotoImport(deps: ProfileDeps, batchId: string): Promise<UndoPhotoImportResult> {
  return withArchiveGuard(
    deps.blobStore,
    async () => {
      const result = await deps.client.call('undoPhotoBatch', { batchId });
      return { found: result.found, removedItems: result.removedItems, removedMedia: await deleteBlobs(deps, result.unreferencedBlobs) };
    },
    deps.lock,
  );
}

export const listPhotoItems = (deps: Pick<ProfileDeps, 'client'>, page: { afterId?: number; limit: number }): Promise<PhotoItem[]> =>
  deps.client.call('listPhotoItems', page);

export const countPhotoItems = (deps: Pick<ProfileDeps, 'client'>): Promise<number> => deps.client.call('countPhotoItems');

export const listPhotoBatches = (deps: Pick<ProfileDeps, 'client'>): Promise<PhotoBatch[]> => deps.client.call('listPhotoBatches');
