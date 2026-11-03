import { ZipDeflate, ZipPassThrough } from 'fflate';
import { createSha256 } from '../../domain/sha256';
import { ArchiveError, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, isSha256Hex } from '../archive/format';
import { createZipSink } from '../archive/zip-sink';
import { type ViewerData, serializeViewerData } from './format';
import { renderViewerHtml } from './html';

/**
 * Writes the viewer package ZIP (layout in docs/formats/viewer-data.md): `viewer.html` (the template
 * with the data inlined), `README.txt` and `media/<sha256>.<ext>`, one entry per `data.media` item.
 * Media are stored, not recompressed (photos, video and voice notes are already compressed), and each
 * is hashed again while it streams out: a blob that no longer matches its hash aborts the export.
 */

export const VIEWER_HTML_PATH = 'viewer.html';
export const VIEWER_README_PATH = 'README.txt';

export interface ViewerPackageSource {
  data: ViewerData;
  /** The stored bytes of one blob, or `undefined` when absent. */
  readBlob(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** The built viewer template (`public/viewer/viewer-template.html`). */
  template: string;
  /** Called after each media file has been written, with how many are done out of the total. */
  onProgress?(done: number, total: number): void;
}

export const VIEWER_README = `Memory Archive - viewer

EN
Open viewer.html in a web browser on a computer. Keep the "media" folder next to it: photos,
videos and voice notes are loaded from there. Nothing is sent anywhere. On a phone, use the
Memory Archive app instead.

CA
Obre viewer.html amb un navegador a l'ordinador. Mantén la carpeta "media" al costat: les fotos,
els vídeos i les notes de veu es carreguen des d'allà. No s'envia res enlloc. Al mòbil, fes servir
l'aplicació Memory Archive.

ES
Abre viewer.html con un navegador en el ordenador. Mantén la carpeta "media" al lado: las fotos,
los vídeos y las notas de voz se cargan desde allí. No se envía nada a ningún sitio. En el móvil,
usa la aplicación Memory Archive.
`;

const MEDIA_ENTRY = /^media\/([0-9a-f]{64})\.[a-z0-9]{1,8}$/;
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

export interface MediaEntryItem {
  /** Path of the entry inside the ZIP. */
  path: string;
  sha256: string;
  size: number;
}

/**
 * Checks the media list before anything is written: every path matches `pattern` (group 1 = the
 * entry's own hash), is unique, and entry count and sizes stay within the archive limits.
 * `extraEntries` are the non-media entries that will share the ZIP.
 */
export function checkMediaEntries(media: MediaEntryItem[], pattern: RegExp, extraEntries = 0): void {
  if (media.length + extraEntries > MAX_ENTRIES) throw new ArchiveError('limit-exceeded', 'too many media files');
  const seen = new Set<string>();
  let total = 0;
  for (const m of media) {
    const match = pattern.exec(m.path);
    if (!match || match[1] !== m.sha256 || !isSha256Hex(m.sha256) || seen.has(m.path)) {
      throw new ArchiveError('unsafe-path', 'a media path is not valid');
    }
    if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_ENTRY_BYTES) {
      throw new ArchiveError('limit-exceeded', 'a media file is too large');
    }
    seen.add(m.path);
    total += m.size;
    if (total > MAX_TOTAL_BYTES) throw new ArchiveError('limit-exceeded', 'the media are too large');
  }
}

type Sink = ReturnType<typeof createZipSink>;

/** Adds a small text entry (deflated). */
export function addTextEntry({ zip, check }: Sink, path: string, text: string, mtime: Date): void {
  const file = new ZipDeflate(path, { level: 6 });
  file.mtime = mtime;
  zip.add(file);
  file.push(encoder.encode(text), true);
  check();
}

/**
 * Streams each media blob into the ZIP (stored, not recompressed), hashing it again on the way: a
 * missing blob or one that no longer matches its hash aborts (the zip is terminated, the error thrown).
 */
export async function addMediaEntries(
  { zip, check }: Sink,
  media: MediaEntryItem[],
  readBlob: (sha256: string) => Promise<ReadableStream<Uint8Array> | undefined>,
  mtime: Date,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  try {
    let done = 0;
    for (const m of media) {
      const stream = await readBlob(m.sha256);
      if (!stream) throw new ArchiveError('blob-missing', 'a media file is missing');
      const file = new ZipPassThrough(m.path);
      file.mtime = mtime;
      zip.add(file);
      const hasher = createSha256();
      let size = 0;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          size += value.length;
          if (size > m.size) break;
          hasher.update(value);
          file.push(value, false);
          check();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (size !== m.size || hasher.digestHex() !== m.sha256) {
        throw new ArchiveError('integrity', 'a media file no longer matches its recorded hash; the library is damaged');
      }
      file.push(EMPTY, true);
      check();
      onProgress?.(++done, media.length);
    }
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export async function writeViewerPackage(source: ViewerPackageSource): Promise<Blob> {
  const { data } = source;
  const media = data.media;
  checkMediaEntries(media, MEDIA_ENTRY);

  let html: string;
  try {
    html = renderViewerHtml(source.template, serializeViewerData(data));
  } catch (error) {
    throw new ArchiveError('storage', 'the viewer template could not be filled', { cause: error });
  }

  const sink = createZipSink();
  const now = new Date(data.createdAt);
  addTextEntry(sink, VIEWER_HTML_PATH, html, now);
  addTextEntry(sink, VIEWER_README_PATH, VIEWER_README, now);
  await addMediaEntries(sink, media, source.readBlob, now, source.onProgress);
  return sink.finish();
}
