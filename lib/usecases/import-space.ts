import { isVideoFileName } from '../importers/whatsapp/message';
import { readZipEntries } from '../importers/whatsapp/zip';
import type { StorageStatus } from '../storage/quota';
import { DEFAULT_IMPORT_LIMITS, zipProblem, type ImportLimits } from './import';

/**
 * "Will this export fit?", answered before anything is written. Reads only the ZIP's central
 * directory (a few KiB, no inflate), so it is cheap enough for the page's main thread.
 *
 * The need is an upper bound: media already in the library (an overlapping export, the same
 * photo twice) is stored once, so a re-import needs far less than this says. A false "does not
 * fit" is shown as a warning the person can override; a false "fits" is what this guards against.
 */

/** Extra room on top of the files: SQLite pages and rows, journals, a temp copy in flight. */
export const SPACE_MARGIN_FACTOR = 1.1;
export const SPACE_MARGIN_FIXED_BYTES = 32 * 1024 * 1024;

export interface ImportSpaceEstimate {
  /** Bytes to reserve for the whole export: its files plus the margin. */
  neededBytes: number;
  /** Bytes still free for this app (quota minus usage), or null when the browser does not say. */
  availableBytes: number | null;
  /** Uncompressed bytes of the video files in the export. */
  videoBytes: number;
  /** null when the quota is unknown: never block on a guess. */
  fits: boolean | null;
  /** Same question with `skipVideos`; null when the quota is unknown. */
  fitsWithoutVideos: boolean | null;
  /** It does not fit, but would without videos: offer "import without videos". */
  suggestSkipVideos: boolean;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * `largest`: the biggest single file. A browser without `FileSystemFileHandle.move()` copies a blob
 * into its final name while the temp file still exists, so one file is on disk twice at the peak.
 */
const needed = (bytes: number, largest: number) => Math.ceil(bytes * SPACE_MARGIN_FACTOR) + SPACE_MARGIN_FIXED_BYTES + largest;

/**
 * "Video" is the importer's own rule (`isVideoFileName`, the one `skipVideos` uses), so the estimate
 * and the import agree. Both numbers are heuristics.
 *
 * Rejects with `ImportError` (`invalid-export`, `limit-exceeded`) for an unreadable ZIP, like the
 * import itself would.
 */
export async function estimateImport(
  zip: Blob,
  storage: Pick<StorageStatus, 'usage' | 'quota'>,
  limits: Partial<ImportLimits> = {},
): Promise<ImportSpaceEstimate> {
  const { maxEntries, maxCentralDirectoryBytes } = { ...DEFAULT_IMPORT_LIMITS, ...limits };
  let entries;
  try {
    entries = await readZipEntries(zip, { maxEntries, maxCentralDirectoryBytes });
  } catch (cause) {
    throw zipProblem(cause);
  }
  let totalBytes = 0;
  let videoBytes = 0;
  let largest = 0;
  let largestNonVideo = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    totalBytes += entry.uncompressedSize;
    largest = Math.max(largest, entry.uncompressedSize);
    if (isVideoFileName(baseName(entry.name))) videoBytes += entry.uncompressedSize;
    else largestNonVideo = Math.max(largestNonVideo, entry.uncompressedSize);
  }
  const availableBytes =
    storage.quota === null || storage.usage === null ? null : Math.max(0, storage.quota - storage.usage);
  const neededBytes = needed(totalBytes, largest);
  const fits = availableBytes === null ? null : neededBytes <= availableBytes;
  const fitsWithoutVideos = availableBytes === null ? null : needed(totalBytes - videoBytes, largestNonVideo) <= availableBytes;
  return {
    neededBytes,
    availableBytes,
    videoBytes,
    fits,
    fitsWithoutVideos,
    suggestSkipVideos: fits === false && videoBytes > 0 && fitsWithoutVideos === true,
  };
}
