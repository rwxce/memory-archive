import { identifyArchiveFile } from '../exporters/changes-pack/identify';
import { isEncryptedBackup } from '../exporters/archive/encrypt';
import { MANIFEST_PATH } from '../exporters/archive/format';
import { isTakeoutLayout, looksLikeMediaDownload } from '../importers/photos/zip-layout';
import { sniffMedia, SNIFF_BYTES, extensionVerdict } from '../importers/photos/sniff';
import { splitPath, TakeoutError } from '../importers/takeout/paths';
import { DEFAULT_TAKEOUT_LIMITS, type TakeoutLimits } from '../importers/takeout/read';
import { findChatEntry, isChatEntry } from '../importers/whatsapp/chat';
import { readZipEntries, ZipLimitError } from '../importers/whatsapp/zip';

/**
 * What a file handed to the app is, decided by its content (never by name or `File.type`), so a
 * screen can send it to the right importer. Reads the first bytes and, for a ZIP, only the central
 * directory (and the manifest of a backup / changes pack). Nothing is imported or written.
 *
 * - `media`: one picture or video (import with `importLoosePhotos`);
 * - `takeout-album`: a Google Takeout ZIP with pictures (`importGooglePhotosZip` / `importTakeoutAlbum`);
 * - `google-photos-zip`: a flat ZIP of pictures and videos from photos.google.com (`importGooglePhotosZip`);
 * - `whatsapp-chat`: a WhatsApp "Export chat" ZIP (the chat import);
 * - `backup`, `changes-pack`: this app's own files (an encrypted file is reported as `backup`: it only
 *   shows what it is once opened, see `detectArchiveFile`);
 * - `unsupported`: anything else, including a ZIP with no picture or video in it.
 */
export type PhotoSourceKind = 'media' | 'takeout-album' | 'google-photos-zip' | 'whatsapp-chat' | 'backup' | 'changes-pack' | 'unsupported';

/** Throws `TakeoutError` `limit-exceeded` for a ZIP whose directory is over the limits. */
export async function detectPhotoSource(file: Blob, limits: Partial<TakeoutLimits> = {}): Promise<{ kind: PhotoSourceKind }> {
  if (await isEncryptedBackup(file)) return { kind: 'backup' };
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  if (sniffMedia(head)) return { kind: 'media' };
  if (!(head[0] === 0x50 && head[1] === 0x4b)) return { kind: 'unsupported' };

  const lim = { ...DEFAULT_TAKEOUT_LIMITS, ...limits };
  let entries;
  try {
    entries = await readZipEntries(file, {
      maxEntries: lim.maxEntries,
      maxCentralDirectoryBytes: lim.maxCentralDirectoryBytes,
      maxTotalBytes: lim.maxTotalBytes,
      maxCompressionRatio: lim.maxCompressionRatio,
    });
  } catch (cause) {
    if (cause instanceof ZipLimitError) throw new TakeoutError('limit-exceeded', 'the file is larger than allowed', { cause });
    return { kind: 'unsupported' };
  }
  if (entries.some((e) => e.name === MANIFEST_PATH)) {
    const kind = await identifyArchiveFile(file).catch(() => 'unknown' as const);
    if (kind !== 'unknown') return { kind };
  }
  const hasMedia = entries.some((e) => !e.name.endsWith('/') && ['photo', 'video'].includes(extensionVerdict(splitPath(e.name).baseName)));
  // A chat export names its transcript `_chat.txt` (iOS) or "WhatsApp Chat with ...txt" in the phone's language
  // (Android). Any other lone text file beside pictures is just a note in a download, not a chat.
  const chat = findChatEntry(entries);
  if (chat && (!hasMedia || isChatEntry(chat.name) || /whatsapp/i.test(splitPath(chat.name).baseName))) return { kind: 'whatsapp-chat' };
  if (!hasMedia) return { kind: 'unsupported' };
  const takeout = isTakeoutLayout(entries);
  // A .docx / .epub / .apk ... embeds pictures too: not a download of pictures.
  if (!looksLikeMediaDownload(entries, takeout)) return { kind: 'unsupported' };
  return { kind: takeout ? 'takeout-album' : 'google-photos-zip' };
}
