import type { BlobRef } from '../domain/library';
import {
  PHOTO_ALBUM_MAX,
  PHOTO_SOURCE_GOOGLE_PHOTOS_ZIP,
  PHOTO_SOURCE_LOOSE,
  betterDate,
  isGuessedDate,
  takenAtFromEpochMs,
  type NewPhotoItem,
} from '../domain/photo';
import { EXIF_PREFIX_BYTES, readExif } from '../importers/photos/exif';
import { acceptMedia } from '../importers/photos/sniff';
import { readPhotoZipLayout } from '../importers/photos/zip-layout';
import { cleanText, displayFileName, splitPath, TakeoutError } from '../importers/takeout/paths';
import { DEFAULT_TAKEOUT_LIMITS, type TakeoutLimits } from '../importers/takeout/read';
import { openZipEntry, ZipLimitError } from '../importers/whatsapp/zip';
import { withArchiveGuard } from './archive-guard';
import { BYTES_PROGRESS_INTERVAL_MS, deleteBlobs, entryStream, isDefiniteDbFailure, type ImportProgress } from './import';
import { importTakeoutAlbum, type TakeoutImportSummary } from './photo-library';
import { newIdOf, nowOf, type ProfileDeps } from './profiles';

/*
 * The other two ways to bring pictures into the collection (`docs/formats/photo-library.md`):
 * files chosen from the device (`importLoosePhotos`) and a ZIP downloaded from photos.google.com
 * (`importGooglePhotosZip`; a Takeout-shaped ZIP is handed to `importTakeoutAlbum`). No screen
 * calls these yet.
 *
 * Same order and safety as the Takeout import: stream each file into the blob store (hashed on
 * the way, never buffered whole; only the first 256 KiB are held to sniff the type and read EXIF),
 * then ONE database transaction writes the batch and items. Interrupted before the save, the
 * database is untouched and this run's new blobs are removed; after a crash they are orphans for
 * `sweepOrphanBlobs`. Nothing leaves the device.
 */

export type PhotoImportProgress = ImportProgress;

/** What a Google Photos download or a loose-files import did. A superset of the Takeout summary. */
export interface PhotoImportSummary extends TakeoutImportSummary {
  /** Items of this run whose date is only the file's last-modified time (a guess, not the original). */
  dateGuessed: number;
  /** Chosen files that could not be read (cloud-only, removed or changed after picking): skipped, the rest imported. */
  unreadableFiles: number;
}

export interface PhotoImportResult {
  /** Null when the import added nothing (no history row is left behind). */
  batchId: string | null;
  summary: PhotoImportSummary;
}

export type GooglePhotosZipResult = PhotoImportResult & {
  /** The ZIP was a Takeout (folders / metadata files): imported by the Takeout importer, source `takeout`. */
  delegatedToTakeout: boolean;
};

/** A file chosen on the device: a `File`, or anything shaped like one. */
export type PhotoFile = Blob & { readonly name: string; readonly lastModified?: number };

interface Candidate {
  /** Cleaned base name. */
  fileName: string;
  /** The raw base name, for the extension check. */
  rawName: string;
  size: number;
  /** Epoch ms or null. Only loose files have one worth using. */
  lastModified: number | null;
  open: () => ReadableStream<Uint8Array>;
  /** A file that fails to read is skipped and counted (loose files). A ZIP entry that fails means a damaged archive: all or nothing. */
  skipUnreadable: boolean;
}

interface IngestInput {
  source: string;
  album: string;
  sourceLabel: string;
  candidates: Candidate[];
  /** Counted into the summary as given. */
  ignoredFiles: number;
  tooLarge: number;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoImportProgress) => void;
}

/** A new database call or store failure is not the file's fault; a ZIP failure is. */
const zipProblem = (cause: unknown): TakeoutError =>
  cause instanceof TakeoutError
    ? cause
    : cause instanceof ZipLimitError
      ? new TakeoutError('limit-exceeded', 'a file in the archive is larger than allowed', { cause })
      : new TakeoutError('invalid-takeout', 'this file is not a readable archive', { cause });

/** Reads up to `max` bytes, then returns them and a stream that replays them before the rest. */
async function takePrefix(stream: ReadableStream<Uint8Array>, max: number): Promise<{ head: Uint8Array; full: ReadableStream<Uint8Array>; cancel: () => Promise<void> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  while (length < max) {
    const next = await reader.read();
    if (next.done) {
      finished = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  const head = new Uint8Array(Math.min(length, max));
  for (let at = 0, i = 0; at < head.length; i++) {
    const take = Math.min(chunks[i].length, head.length - at);
    head.set(chunks[i].subarray(0, take), at);
    at += take;
  }
  let i = 0;
  const full = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
        return;
      }
      if (finished) {
        controller.close();
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head, full, cancel: () => reader.cancel().catch(() => undefined) };
}

async function ingest(deps: ProfileDeps, input: IngestInput): Promise<PhotoImportResult> {
  const { signal, onProgress, candidates } = input;
  const stored = new Set(await deps.blobStore.list());
  const written: string[] = [];
  const blobs = new Map<string, BlobRef>();
  const items = new Map<string, NewPhotoItem>();
  let duplicatesInFile = 0;
  let unsupported = input.ignoredFiles;
  let unreadable = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  const totalBytes = candidates.reduce((sum, c) => sum + c.size, 0);
  const reportMedia = () => {
    lastReport = Date.now();
    onProgress?.({ phase: 'media', done, total: candidates.length, bytes, totalBytes });
  };
  const onBytes = (n: number) => {
    bytes += n;
    if (Date.now() - lastReport >= BYTES_PROGRESS_INTERVAL_MS) reportMedia();
  };
  let saving = false;
  const entryFailure: { error?: unknown } = {};
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  try {
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      reportMedia();
      let prefixed;
      let media;
      let info;
      try {
        prefixed = await takePrefix(entryStream(candidate.open(), signal, entryFailure, onBytes), EXIF_PREFIX_BYTES);
        media = acceptMedia(candidate.rawName, prefixed.head);
        if (media) info = await deps.blobStore.put(prefixed.full);
      } catch (error) {
        // Only a failure of the file's own bytes is skipped; a store failure or an abort is not the file's fault.
        const readFailed = entryFailure.error !== undefined || prefixed === undefined;
        if (!candidate.skipUnreadable || signal?.aborted || !readFailed) throw error;
        entryFailure.error = undefined;
        unreadable++;
        done++;
        continue;
      }
      if (!media || !info) {
        await prefixed.cancel();
        unsupported++;
        done++;
        continue;
      }
      const exif = media.kind === 'photo' ? readExif(prefixed.head, media.exif) : null;
      if (!stored.has(info.sha256)) {
        stored.add(info.sha256);
        written.push(info.sha256);
      }
      blobs.set(info.sha256, { sha256: info.sha256, size: info.size, mime: media.mime });

      let item: NewPhotoItem;
      if (exif?.takenAt) {
        item = {
          ...base(info.sha256, media, candidate, input.album),
          takenAt: exif.takenAt,
          dateSource: exif.zone === 'offset' ? 'exif' : 'exif-local',
          takenOffsetMinutes: exif.zone === 'offset' ? exif.offsetMinutes : null,
        };
      } else {
        const modified = takenAtFromEpochMs(candidate.lastModified, nowMs);
        item = { ...base(info.sha256, media, candidate, input.album), takenAt: modified, dateSource: modified ? 'file-modified' : 'none' };
      }
      item.latitude = exif?.latitude ?? null;
      item.longitude = exif?.longitude ?? null;

      const key = `${info.sha256}\n${input.album}`;
      const existing = items.get(key);
      if (existing) {
        duplicatesInFile++;
        // The same picture twice: keep the more trustworthy date, and a place if either copy has one.
        const best = betterDate(existing, item);
        existing.takenAt = best.takenAt;
        existing.dateSource = best.dateSource;
        existing.takenOffsetMinutes = best.takenOffsetMinutes;
        if (existing.latitude === null && item.latitude !== null) {
          existing.latitude = item.latitude;
          existing.longitude = item.longitude;
        }
      } else items.set(key, item);
      done++;
    }
    reportMedia();
    signal?.throwIfAborted();
    if (unreadable > 0 && items.size === 0 && unsupported === input.ignoredFiles) {
      throw new TakeoutError('unreadable-files', 'none of the chosen files could be read');
    }

    onProgress?.({ phase: 'saving', done: 0, total: items.size });
    saving = true;
    const result = await deps.client.call('importPhotoItems', {
      batchId: newIdOf(deps),
      source: input.source,
      sourceLabel: input.sourceLabel,
      now: nowOf(deps),
      blobs: [...blobs.values()],
      items: [...items.values()],
    });
    onProgress?.({ phase: 'saving', done: items.size, total: items.size });

    const unreferenced = new Set(result.unreferencedBlobs);
    await deleteBlobs(deps, unreferenced);
    const wasted = written.filter((h) => unreferenced.has(h)).length;
    const all = [...items.values()];
    return {
      batchId: result.batchId,
      summary: {
        added: result.added,
        alreadyThere: result.skipped,
        duplicatesInFile,
        mediaAdded: written.length - wasted,
        withoutDate: all.filter((i) => i.takenAt === null).length,
        dateGuessed: all.filter((i) => isGuessedDate(i.dateSource)).length,
        unreadableFiles: unreadable,
        ignoredFiles: unsupported,
        unusableSidecars: 0,
        tooLarge: input.tooLarge,
      },
    };
  } catch (error) {
    // Nothing was committed (before the save step, or the database refused): this run's bytes are
    // unreferenced. A lost connection is ambiguous, so those stay for the sweep.
    if (!saving || isDefiniteDbFailure(error)) await deleteBlobs(deps, written);
    if (signal?.aborted && !saving) throw signal.reason;
    if (entryFailure.error !== undefined && !signal?.aborted) throw zipProblem(entryFailure.error);
    throw error;
  }
}

const base = (sha256: string, media: { kind: NewPhotoItem['kind']; mime: string }, candidate: Candidate, album: string): NewPhotoItem => ({
  sha256,
  kind: media.kind,
  mime: media.mime,
  takenAt: null,
  takenOffsetMinutes: null,
  dateSource: 'none',
  latitude: null,
  longitude: null,
  description: '',
  album,
  fileName: candidate.fileName,
});

export interface ImportLoosePhotosInput {
  /** The files chosen from `<input type=file multiple>` or a gallery picker. */
  files: readonly PhotoFile[];
  /** An optional name to group this selection under (the album of its items). Untrusted text. */
  label?: string;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoImportProgress) => void;
  /** `maxEntries` bounds the number of files; `maxMediaBytes` one file; `maxTotalBytes` the selection. */
  limits?: Partial<TakeoutLimits>;
}

/**
 * Imports pictures and videos picked on the device. A file is kept when its BYTES are a supported
 * picture or video (the file's `type` is never trusted) and its extension does not contradict
 * that; anything else is counted in `ignoredFiles`. The date taken is the EXIF one when there is
 * one, else the file's last-modified time marked `file-modified` (a guess), else none. Not
 * assigned to any profile. All or nothing and idempotent. Rejects with `TakeoutError`
 * (`limit-exceeded`), `ArchiveError` (`busy`) or `DbError`; an abort rejects with the signal's reason.
 */
export function importLoosePhotos(deps: ProfileDeps, input: ImportLoosePhotosInput): Promise<PhotoImportResult> {
  return withArchiveGuard(
    deps.blobStore,
    async () => {
      const { signal, onProgress } = input;
      signal?.throwIfAborted();
      const lim = { ...DEFAULT_TAKEOUT_LIMITS, ...input.limits };
      onProgress?.({ phase: 'reading', done: 0, total: 1 });
      if (input.files.length > lim.maxEntries) throw new TakeoutError('limit-exceeded', 'too many files chosen at once');
      let tooLarge = 0;
      let total = 0;
      const candidates: Candidate[] = [];
      for (const file of input.files) {
        if (file.size > lim.maxMediaBytes) {
          tooLarge++;
          continue;
        }
        total += file.size;
        if (total > lim.maxTotalBytes) throw new TakeoutError('limit-exceeded', 'the chosen files are larger than allowed');
        const rawName = splitPath(String(file.name).replace(/\\/g, '/')).baseName;
        candidates.push({
          fileName: displayFileName(rawName),
          rawName,
          size: file.size,
          lastModified: typeof file.lastModified === 'number' ? file.lastModified : null,
          open: () => file.stream(),
          skipUnreadable: true,
        });
      }
      onProgress?.({ phase: 'reading', done: 1, total: 1 });
      const label = cleanText(input.label ?? '', PHOTO_ALBUM_MAX);
      return ingest(deps, { source: PHOTO_SOURCE_LOOSE, album: label, sourceLabel: label, candidates, ignoredFiles: 0, tooLarge, signal, onProgress });
    },
    deps.lock,
  );
}

export interface ImportGooglePhotosZipInput {
  /** A ZIP from photos.google.com ("Download" of selected photos), or a Takeout ZIP. */
  zip: Blob;
  /** Base name of the file, shown in the import history (untrusted). */
  fileName: string;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoImportProgress) => void;
  limits?: Partial<TakeoutLimits>;
}

/**
 * Imports a ZIP downloaded from Google Photos. A flat ZIP of pictures and videos is read here
 * (type by bytes, date from EXIF, otherwise none: a ZIP entry's own time is not the capture time,
 * so no `file-modified` guess); source `google-photos-zip`, no album. A ZIP laid out as a Takeout
 * (a `Takeout/` folder or metadata JSON files) goes to `importTakeoutAlbum` unchanged
 * (`delegatedToTakeout`). Same errors as `importTakeoutAlbum`.
 */
export async function importGooglePhotosZip(deps: ProfileDeps, input: ImportGooglePhotosZipInput): Promise<GooglePhotosZipResult> {
  const { signal, onProgress } = input;
  signal?.throwIfAborted();
  onProgress?.({ phase: 'reading', done: 0, total: 1 });
  let layout;
  try {
    layout = await readPhotoZipLayout(input.zip, input.limits);
  } catch (cause) {
    signal?.throwIfAborted();
    throw zipProblem(cause);
  }
  if (layout.takeout) {
    const result = await importTakeoutAlbum(deps, { ...input, limits: input.limits });
    return { delegatedToTakeout: true, batchId: result.batchId, summary: { ...result.summary, dateGuessed: 0, unreadableFiles: 0 } };
  }
  if (layout.candidates.length === 0 && layout.tooLarge === 0) throw new TakeoutError('invalid-takeout', 'there are no pictures or videos in this file');
  onProgress?.({ phase: 'reading', done: 1, total: 1 });
  const zip = input.zip;
  const result = await withArchiveGuard(
    deps.blobStore,
    () =>
      ingest(deps, {
        source: PHOTO_SOURCE_GOOGLE_PHOTOS_ZIP,
        album: '',
        sourceLabel: cleanText(input.fileName, 1000),
        candidates: layout.candidates.map((c) => ({
          fileName: c.fileName,
          rawName: splitPath(c.entry.name).baseName,
          size: c.entry.uncompressedSize,
          lastModified: null,
          open: () => openZipEntry(zip, c.entry),
          skipUnreadable: false,
        })),
        ignoredFiles: layout.ignored,
        tooLarge: layout.tooLarge,
        signal,
        onProgress,
      }),
    deps.lock,
  );
  return { delegatedToTakeout: false, ...result };
}
