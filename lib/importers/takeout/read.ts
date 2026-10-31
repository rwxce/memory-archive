import { readZipEntries, readZipEntryBytes, ZipLimitError, type ZipEntry } from '../whatsapp/zip';
import type { PhotoKind } from '../../domain/photo';
import { findSidecarByName, findSidecarByTitle, livePhotoKey, type SidecarInfo } from './match';
import { albumFolderOf, checkTakeoutPath, classifyEntry, displayFileName, splitPath, TakeoutError } from './paths';
import { MAX_SIDECAR_BYTES, parseAlbumTitle, parseSidecar, type PhotoMetadata } from './sidecar';

/**
 * Reads the layout of a Google Photos Takeout ZIP (an album, several albums, or a whole library):
 * which entries are pictures and videos, which album each is in and what its sidecar says. It
 * reads only the central directory and the small JSON entries; the media bytes are streamed later
 * by the caller (`openZipEntry`), one file at a time. Supported name variants and what is
 * ignored: `match.ts` and `docs/formats/photo-library.md`.
 */

export interface TakeoutLimits {
  /** Entries a ZIP may declare. */
  maxEntries: number;
  /** Declared size of the central directory. */
  maxCentralDirectoryBytes: number;
  /** Uncompressed size of one picture or video. */
  maxMediaBytes: number;
  /** Declared uncompressed sizes of all entries together. */
  maxTotalBytes: number;
  /** Declared uncompressed / compressed size of a deflated entry (zip-bomb guard). */
  maxCompressionRatio: number;
}

export const DEFAULT_TAKEOUT_LIMITS: TakeoutLimits = {
  maxEntries: 100_000,
  maxCentralDirectoryBytes: 32 * 1024 * 1024,
  maxMediaBytes: 4 * 1024 ** 3,
  maxTotalBytes: 256 * 1024 ** 3,
  maxCompressionRatio: 100,
};

export interface TakeoutItemPlan {
  entry: ZipEntry;
  album: string;
  /** Base name, cleaned. */
  fileName: string;
  kind: PhotoKind;
  mime: string;
  /** Null when no sidecar was found or it was unusable. */
  metadata: Omit<PhotoMetadata, 'title'> | null;
  /** Where the metadata came from. */
  metadataSource: 'sidecar' | 'live-photo' | 'none';
}

export interface TakeoutPlan {
  items: TakeoutItemPlan[];
  stats: {
    /** Entries that are neither a picture, a video nor JSON (html index, thumbnails of other kinds...). */
    ignored: number;
    /** Sidecars that were too large, not UTF-8 JSON, or not an object. */
    unusableSidecars: number;
    /** Pictures and videos too large for `maxMediaBytes`, skipped. */
    tooLarge: number;
  };
}

const nameCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Folder {
  albumName: string;
  media: { entry: ZipEntry; baseName: string; kind: PhotoKind; mime: string }[];
  sidecarEntries: { entry: ZipEntry; baseName: string }[];
  metadataEntry: ZipEntry | null;
}

export async function readTakeoutZip(zip: Blob, limits: Partial<TakeoutLimits> = {}): Promise<TakeoutPlan> {
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

  const stats = { ignored: 0, unusableSidecars: 0, tooLarge: 0 };
  const folders = new Map<string, Folder>();
  // Every name is checked before any is used: one hostile name refuses the whole file.
  for (const entry of entries) checkTakeoutPath(entry.name);
  for (const entry of [...entries].sort((a, b) => nameCompare(a.name, b.name))) {
    if (entry.name.endsWith('/')) continue;
    const { dirs, baseName } = splitPath(entry.name);
    const klass = classifyEntry(baseName);
    if (klass.type === 'ignored') {
      stats.ignored++;
      continue;
    }
    const album = albumFolderOf(dirs);
    let folder = folders.get(album.key);
    if (!folder) {
      folder = { albumName: album.name, media: [], sidecarEntries: [], metadataEntry: null };
      folders.set(album.key, folder);
    }
    if (klass.type === 'media') {
      if (entry.uncompressedSize > lim.maxMediaBytes) stats.tooLarge++;
      else folder.media.push({ entry, baseName, kind: klass.kind, mime: klass.mime });
    } else if (klass.type === 'album-metadata') folder.metadataEntry = entry;
    else folder.sidecarEntries.push({ entry, baseName });
  }

  const readSmall = async (entry: ZipEntry): Promise<Uint8Array | null> => {
    // Declared size first (nothing is read for a big one); the stream itself is bounded by the declared size.
    if (entry.uncompressedSize > MAX_SIDECAR_BYTES) return null;
    try {
      return await readZipEntryBytes(zip, entry);
    } catch {
      return null;
    }
  };

  const items: TakeoutItemPlan[] = [];
  for (const folder of folders.values()) {
    if (folder.media.length === 0) continue;
    let albumName = folder.albumName;
    if (folder.metadataEntry && albumName !== '') {
      const bytes = await readSmall(folder.metadataEntry);
      albumName = (bytes && parseAlbumTitle(bytes)) || albumName;
    }
    const sidecars = new Map<string, SidecarInfo>();
    const parsed = new Map<string, PhotoMetadata>();
    for (const { entry, baseName } of folder.sidecarEntries) {
      const bytes = await readSmall(entry);
      const metadata = bytes ? parseSidecar(bytes) : null;
      if (!metadata) {
        stats.unusableSidecars++;
        continue;
      }
      sidecars.set(baseName, { name: baseName, title: metadata.title });
      parsed.set(baseName, metadata);
    }
    const own = new Map<(typeof folder.media)[number], PhotoMetadata>();
    const claimed = new Set<string>();
    for (const m of folder.media) {
      const found = findSidecarByName(m.baseName, sidecars);
      if (found) {
        own.set(m, parsed.get(found.name)!);
        claimed.add(found.name);
      }
    }
    for (const m of folder.media) {
      if (own.has(m)) continue;
      const found = findSidecarByTitle(m.baseName, sidecars, claimed);
      if (found) own.set(m, parsed.get(found.name)!);
    }
    // A live photo's video often has no sidecar of its own: borrow its still image's (or the other way round).
    const byLiveKey = new Map<string, PhotoMetadata>();
    for (const [m, metadata] of own) {
      const key = `${m.kind}:${livePhotoKey(m.baseName)}`;
      if (!byLiveKey.has(key)) byLiveKey.set(key, metadata);
    }
    for (const m of folder.media) {
      const sidecar = own.get(m) ?? null;
      const partner = sidecar ? null : (byLiveKey.get(`${m.kind === 'photo' ? 'video' : 'photo'}:${livePhotoKey(m.baseName)}`) ?? null);
      const metadata = sidecar ?? partner;
      items.push({
        entry: m.entry,
        album: albumName,
        fileName: displayFileName(m.baseName),
        kind: m.kind,
        mime: m.mime,
        metadata: metadata
          ? { takenAt: metadata.takenAt, latitude: metadata.latitude, longitude: metadata.longitude, description: metadata.description }
          : null,
        metadataSource: sidecar ? 'sidecar' : partner ? 'live-photo' : 'none',
      });
    }
  }
  if (items.length === 0) throw new TakeoutError('invalid-takeout', 'there are no pictures or videos in this file');
  return { items, stats };
}
