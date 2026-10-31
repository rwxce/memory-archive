import { isAppleDouble } from '../whatsapp/chat';
import { readZipEntries, ZipLimitError, type ZipEntry } from '../whatsapp/zip';
import { DEFAULT_TAKEOUT_LIMITS, type TakeoutLimits } from '../takeout/read';
import { checkTakeoutPath, classifyEntry, displayFileName, splitPath, TakeoutError } from '../takeout/paths';
import { extensionVerdict } from './sniff';

/**
 * Reads the layout of a ZIP from photos.google.com ("Download" of a selection): a flat list of
 * pictures and videos, usually without metadata files. Only the central directory is read. A ZIP
 * with a `Takeout/` folder or JSON metadata files is a Takeout (Google's other export) and is
 * reported as such, so the caller hands it to the Takeout importer. Names are untrusted: one
 * hostile name refuses the file. Whether an entry really is a picture is decided later, by its
 * bytes (`sniff.ts`). `docs/formats/photo-library.md`.
 */

export interface PhotoZipCandidate {
  entry: ZipEntry;
  /** Base name, cleaned. */
  fileName: string;
}

export type PhotoZipLayout =
  | { takeout: true; entries: ZipEntry[] }
  | {
      takeout: false;
      /** Entries to look at, in name order: a media extension, or no extension (the bytes decide). */
      candidates: PhotoZipCandidate[];
      /** AppleDouble companions and files with another extension (folders are not counted). */
      ignored: number;
      /** Declared above `maxMediaBytes`: skipped. */
      tooLarge: number;
    };

const nameCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** True for a ZIP laid out like a Google Takeout: a `Takeout/` folder or metadata JSON beside the media. */
export function isTakeoutLayout(entries: readonly ZipEntry[]): boolean {
  return entries.some((e) => {
    if (e.name.startsWith('Takeout/')) return true;
    const klass = classifyEntry(splitPath(e.name).baseName);
    return klass.type === 'sidecar' || klass.type === 'album-metadata';
  });
}

/** Roots that make a ZIP a document, e-book or app package (Office, ODF, EPUB, APK/JAR), never a download of pictures. */
const FOREIGN_ROOT_FILES = new Set(['[Content_Types].xml', 'mimetype', 'AndroidManifest.xml']);
const FOREIGN_ROOT_FOLDERS = new Set(['META-INF', 'word', 'ppt', 'xl', 'OEBPS', 'Payload']);
/** Beside pictures these are thumbnails, notes or captions: they do not count against "mostly pictures". */
const COMPANION_EXTENSIONS = new Set(['json', 'txt', 'html', 'htm', 'csv']);

/**
 * True when the ZIP looks like a download of pictures and videos rather than a document that
 * merely embeds some (`.docx` / `.pptx` / `.xlsx` / `.epub` / `.odt` / `.apk` all hold
 * `word/media/image1.png`-style entries): none of the package roots above, and more pictures /
 * videos (or extension-less files, which the bytes decide) than other files, companions and
 * AppleDouble files not counted. A Takeout (`takeout` layout) keeps only the package-root rule.
 */
export function looksLikeMediaDownload(entries: readonly ZipEntry[], takeout: boolean): boolean {
  let media = 0;
  let other = 0;
  for (const entry of entries) {
    const root = entry.name.split('/')[0];
    if (FOREIGN_ROOT_FOLDERS.has(root) && entry.name.includes('/')) return false;
    if (!entry.name.includes('/') && FOREIGN_ROOT_FILES.has(entry.name)) return false;
    if (entry.name.endsWith('/') || isAppleDouble(entry.name)) continue;
    const { baseName } = splitPath(entry.name);
    const verdict = extensionVerdict(baseName);
    if (verdict !== 'other') media++;
    else if (!COMPANION_EXTENSIONS.has(baseName.slice(baseName.lastIndexOf('.') + 1).toLowerCase())) other++;
  }
  return takeout || media > other;
}

export async function readPhotoZipLayout(zip: Blob, limits: Partial<TakeoutLimits> = {}): Promise<PhotoZipLayout> {
  const lim = { ...DEFAULT_TAKEOUT_LIMITS, ...limits };
  let entries: ZipEntry[];
  try {
    entries = await readZipEntries(zip, {
      maxEntries: lim.maxEntries,
      maxCentralDirectoryBytes: lim.maxCentralDirectoryBytes,
      maxTotalBytes: lim.maxTotalBytes,
      maxCompressionRatio: lim.maxCompressionRatio,
    });
  } catch (cause) {
    if (cause instanceof ZipLimitError) throw new TakeoutError('limit-exceeded', 'the file is larger than allowed', { cause });
    throw new TakeoutError('invalid-takeout', 'this file is not a readable ZIP', { cause });
  }
  for (const entry of entries) checkTakeoutPath(entry.name);
  const takeout = isTakeoutLayout(entries);
  if (!looksLikeMediaDownload(entries, takeout)) throw new TakeoutError('invalid-takeout', 'this file is not a download of pictures and videos');
  if (takeout) return { takeout: true, entries };

  let ignored = 0;
  let tooLarge = 0;
  const candidates: PhotoZipCandidate[] = [];
  for (const entry of [...entries].sort((a, b) => nameCompare(a.name, b.name))) {
    const { baseName } = splitPath(entry.name);
    if (entry.name.endsWith('/')) continue;
    if (isAppleDouble(entry.name) || extensionVerdict(baseName) === 'other') {
      ignored++;
      continue;
    }
    if (entry.uncompressedSize > lim.maxMediaBytes) tooLarge++;
    else candidates.push({ entry, fileName: displayFileName(baseName) });
  }
  return { takeout: false, candidates, ignored, tooLarge };
}
