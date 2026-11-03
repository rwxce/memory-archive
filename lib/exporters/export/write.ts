import { createZipSink } from '../archive/zip-sink';
import { addMediaEntries, addTextEntry, checkMediaEntries } from '../viewer/write';
import type { ExportFile, ExportMediaEntry } from './files';

/**
 * Writes the ZIP of a non-viewer export: the text files (deflated), then the media (stored, each
 * rehashed while it streams out). Same checks and limits as the viewer package; the shared helpers
 * live in `viewer/write.ts`.
 */

export interface ExportZipSource {
  /** UTC instant, used as the entries' modification time (keeps the ZIP deterministic). */
  createdAt: string;
  files: ExportFile[];
  media: ExportMediaEntry[];
  readBlob(sha256: string): Promise<ReadableStream<Uint8Array> | undefined>;
  onProgress?(done: number, total: number): void;
}

/** `[<folder>/]media/<sha256>.<ext>`; the folder is a `slug`, so it starts with a letter or digit. */
const MEDIA_ENTRY = /^(?:[a-z0-9][a-z0-9-]{0,63}\/)?media\/([0-9a-f]{64})\.[a-z0-9]{1,8}$/;

export async function writeExportZip(source: ExportZipSource): Promise<Blob> {
  checkMediaEntries(source.media, MEDIA_ENTRY, source.files.length);
  const sink = createZipSink();
  const now = new Date(source.createdAt);
  for (const file of source.files) addTextEntry(sink, file.path, file.text, now);
  await addMediaEntries(sink, source.media, source.readBlob, now, source.onProgress);
  return sink.finish();
}
