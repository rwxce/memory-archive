import { DbError } from '../db/errors';
import { ArchiveError } from '../exporters/archive/format';
import { BlobStoreError } from '../storage/blob-store';
import type { StorageStatus } from '../storage/quota';
import { ImportError, type ConversationTarget } from './import';
import type { ImportPreview } from './import-preview';
import type { ImportWorkerInput, PreviewWorkerInput } from './import-protocol';

/**
 * What the import wizard decides, as plain data, and how it becomes the requests the import
 * use cases take. Pure: no I/O, no React. The wizard's screens keep these choices per file and
 * call these functions, so the rules (which author is passed as "me", what the date choice
 * means, what counts as an importable file) are tested here and not in a component.
 */

/** Why a preview or an import failed, in terms the UI has copy for. The raw error message is never shown. */
export type ImportProblem =
  /** Not a readable WhatsApp export (not a ZIP, no chat in it, no messages). */
  | 'invalid-export'
  /** Over the size limits (too many files, a chat or a file that is too big). */
  | 'too-big'
  /** Another archive operation is running (here or in another tab). */
  | 'busy'
  /** The import worker crashed, did not start or ignored a cancel. */
  | 'worker-failed'
  /** The device could not store the files. */
  | 'storage'
  | 'other';

export function importProblemOf(error: unknown): ImportProblem {
  if (error instanceof ImportError) {
    if (error.code === 'invalid-export') return 'invalid-export';
    if (error.code === 'limit-exceeded') return 'too-big';
    if (error.code === 'worker-failed') return 'worker-failed';
    return 'other';
  }
  if (error instanceof ArchiveError) return error.code === 'busy' ? 'busy' : 'other';
  if (error instanceof BlobStoreError) return 'storage';
  if (error instanceof DbError) return 'other';
  if (error instanceof Error && error.name === 'QuotaExceededError') return 'storage';
  return 'other';
}

/**
 * A ZIP or a plain-text chat export (the "without media" `.txt`), by extension or type. This only
 * decides what the picker offers; the import itself looks at the content, never at the name.
 * Loose media are not importable yet.
 */
export function isImportableExport(file: Pick<File, 'name' | 'type'>): boolean {
  if (/\.(zip|txt)$/i.test(file.name)) return true;
  const type = file.type.split(';')[0].trim().toLowerCase();
  return type === 'application/zip' || type === 'application/x-zip-compressed' || type === 'text/plain';
}

/** How the person read an ambiguous date such as 03/04/2026. */
export type DateOrder = 'day-first' | 'month-first';

/** Where the conversation goes, as the person chose it. `auto`: the import decides (a new one, or the one this continues). */
export type ConversationChoice = { mode: 'auto' } | { mode: 'new' } | { mode: 'existing'; conversationId: string };

/** The choices the wizard collects for one file. Everything the preview and the import need besides the file. */
export interface WizardChoices {
  /** Empty for "decide later" (the conversation is not assigned to anyone yet). */
  profileIds: string[];
  /** The author who is the person themselves; null when they are not in the chat or do not know. */
  meAuthor: string | null;
  conversation: ConversationChoice;
  dateOrder?: DateOrder;
  skipVideos: boolean;
}

const dateFlags = (order: DateOrder | undefined) =>
  order === 'day-first' ? { dayFirst: true } : order === 'month-first' ? { monthFirst: true } : {};

const targetOf = (choice: ConversationChoice): ConversationTarget => choice;

/** The preview request for a file under the choices made so far. */
export function previewRequest(
  file: Pick<File, 'name'> & Blob,
  choices: Pick<WizardChoices, 'profileIds' | 'conversation' | 'dateOrder'>,
  storage: Pick<StorageStatus, 'usage' | 'quota'>,
): PreviewWorkerInput {
  return {
    zip: file,
    fileName: file.name,
    profileIds: choices.profileIds,
    conversation: targetOf(choices.conversation),
    storage: { usage: storage.usage, quota: storage.quota },
    ...dateFlags(choices.dateOrder),
  };
}

/** The import request for a file under the final choices. */
export function importRequest(file: Pick<File, 'name'> & Blob, choices: WizardChoices): ImportWorkerInput {
  return {
    zip: file,
    fileName: file.name,
    profileIds: choices.profileIds,
    conversation: targetOf(choices.conversation),
    meAuthor: choices.meAuthor,
    options: { skipVideos: choices.skipVideos },
    ...dateFlags(choices.dateOrder),
  };
}

/** Messages the import will add, as far as the check can tell: the new ones for a known conversation, all of them otherwise. */
export function messagesToAdd(check: ImportPreview): number {
  return check.duplicates.status === 'existing' ? check.duplicates.wouldAdd : check.messageCount;
}

/**
 * The author to select as "me" when the step opens. The guess is shown as a guess, never applied
 * silently; an author that is not in the (capped) list cannot be selected.
 */
export function guessedMe(preview: ImportPreview): string | null {
  const guess = preview.suggestedMe;
  return guess !== null && preview.authors.some((author) => author.name === guess) ? guess : null;
}

/** Does it fit? Honors "without videos" and never blocks on an unknown quota (`null`). */
export function spaceFits(preview: ImportPreview, skipVideos: boolean): boolean | null {
  return skipVideos ? preview.space.fitsWithoutVideos : preview.space.fits;
}
