import { legacyAsTranscript } from '../importers/legacy/transcript';
import { asImportArchive } from '../importers/whatsapp/text-export';

/**
 * What an import source is, decided by content: the archive the import reads, and the date order
 * to read it with. A ZIP passes through, a bare `.txt` export is wrapped, and an old wa-backup
 * output (`messages.json` / `.html` / `.csv`) is written back as a transcript (see
 * `importers/legacy/transcript.ts`). The wrapper's folder carries the chat name the output
 * records, the same way a ZIP's top folder does; without one (CSV) the file name stands in.
 */
export interface ImportSource {
  zip: Blob;
  /** Set when the source knows its date order (a legacy output wrote its dates day-first itself); it overrides the person's choice. */
  dateOrder?: { dayFirst: boolean; monthFirst: boolean };
}

/** A name safe as the one folder of the wrapper archive. */
function folderName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 200);
}

const stemOf = (fileName: string): string => (fileName.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');

/** Throws `ZipLimitError` over the size cap; a malformed legacy output throws `LegacyFormatError`. */
export async function openImportSource(file: Blob, fileName: string, maxChatBytes: number): Promise<ImportSource> {
  const legacy = await legacyAsTranscript(file, maxChatBytes);
  if (!legacy) return { zip: await asImportArchive(file, maxChatBytes) };
  const folder = folderName(legacy.chatName ?? '') || folderName(stemOf(fileName));
  const zip = await asImportArchive(legacy.transcript, maxChatBytes, folder === '' ? undefined : `${folder}/_chat.txt`);
  return { zip, dateOrder: { dayFirst: true, monthFirst: false } };
}
