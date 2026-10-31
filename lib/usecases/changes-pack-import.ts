import { DbError } from '../db/errors';
import { SCHEMA_VERSION } from '../db/migrations';
import {
  PackRecordError,
  parsePackBatchHeader,
  parsePackBlob,
  parsePackConversation,
  parsePackFavorite,
  parsePackMessage,
  parsePackNote,
  parsePackProfile,
  parsePackTombstone,
} from '../domain/changes-pack-parse';
import type { PackBlob, PackMessage } from '../domain/changes-pack';
import type { MergeChangesPackInput, MergeCounts, MergeRefusal, SyncPeer } from '../domain/sync';
import { isEncryptedBackup, openBackupBlob, type CryptoProgress } from '../exporters/archive/encrypt';
import { ArchiveError, DEFAULT_LIMITS, type ArchiveLimits } from '../exporters/archive/format';
import { guardedStream } from '../exporters/archive/read';
import { classifyPackPath, recordPath, type ChangesPackCounts } from '../exporters/changes-pack/format';
import { identifyArchiveFile, type ArchiveFileKind } from '../exporters/changes-pack/identify';
import { openChangesPack, readPackLines, type OpenedChangesPack } from '../exporters/changes-pack/read';
import type { ArchiveProgress } from './archive-core';
import { withArchiveGuard } from './archive-guard';
import { deleteBlobs } from './import';
import { nowOf, type ProfileDeps } from './profiles';

/*
 * Importing a changes pack = MERGING it (`docs/formats/changes-pack.md`, "Merge"). Like the export
 * it reaches the database only through `deps.client`.
 *
 * Order, and why a failure leaves the library exactly as it was:
 *   1. open the pack (decrypting it first when sealed) and refuse it early: wrong device, own pack,
 *      a gap, a newer format or schema (reads only);
 *   2. read and validate EVERY record (the pack is untrusted; nothing is written);
 *   3. media: stream each file the library lacks into the content-addressed store, hash-verified.
 *      Bytes land in the store BEFORE the database knows them; on any later failure the files this
 *      import added are removed again (a crash leaves orphans the next sweep removes);
 *   4. ONE database transaction merges the records and moves the received watermark.
 *
 * Known limit: the records of a pack (not its media) are held in memory and cross the worker
 * boundary in one request, bounded by `maxRecordBytes`; a pack above it is refused with a
 * `limit-exceeded` and the sender is asked for smaller ones.
 */

export type ChangesPackMergeCode = MergeRefusal;

/** The pack is not for this device, was made by it, or leaves a hole in what was received. Nothing was changed. */
export class ChangesPackMergeError extends Error {
  readonly code: ChangesPackMergeCode;
  constructor(code: ChangesPackMergeCode, message: string) {
    super(message);
    this.name = 'ChangesPackMergeError';
    this.code = code;
  }
}

const REFUSALS: Record<MergeRefusal, string> = {
  'wrong-device': 'this changes pack was made for another device',
  'own-pack': 'this changes pack was made by this device',
  gap: 'a changes pack between this one and the last one merged is missing; ask the sender for a full pack',
};

/** Largest total size of the record files (everything but media) a merge will hold in memory. */
export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024 * 1024;

export interface ImportChangesPackOptions {
  limits?: Partial<ArchiveLimits>;
  maxRecordBytes?: number;
  /** Needed when the file is encrypted (`password-required` / `wrong-password`); ignored for a plain ZIP. */
  password?: string;
  onProgress?: (progress: ArchiveProgress) => void;
  onCryptoProgress?: (progress: CryptoProgress) => void;
  signal?: AbortSignal;
}

export interface ImportChangesPackResult {
  kind: 'changes' | 'full';
  sourceDeviceId: string;
  /** Whether the file was password-encrypted. */
  encrypted: boolean;
  counts: MergeCounts;
  /** Crossed edits kept beside the active records, waiting for the person (`listSyncConflicts`). */
  conflicts: number;
  /** Imports the other device undid, offered for review; nothing was removed here. */
  batchOffers: number;
  /** The state of the exchange with the source after the merge. */
  peer: SyncPeer;
}

const broken = (error: unknown): never => {
  if (error instanceof PackRecordError) throw new ArchiveError('integrity', error.message, { cause: error });
  throw error;
};

async function readRecords<T>(zip: Blob, opened: OpenedChangesPack, name: Parameters<typeof recordPath>[0], parse: (raw: unknown) => T, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const line of readPackLines(zip, opened, recordPath(name), signal)) out.push(parse(line));
  } catch (error) {
    broken(error);
  }
  return out;
}

/**
 * Merges a changes pack into the library. All or nothing: any failure (a damaged or hostile pack,
 * a refusal, a full disk) leaves the database and the media store as they were. Importing the same
 * pack again changes nothing. Rejects with `ArchiveError` (`busy`, `password-required`,
 * `wrong-password`, `not-an-archive`, `invalid-manifest` (a backup or something else),
 * `newer-format`, `newer-schema`, `unsafe-path`, `limit-exceeded`, `integrity`, `storage`, ...),
 * `ChangesPackMergeError` (`wrong-device`, `own-pack`, `gap`) or `DbError`.
 */
export function importChangesPack(deps: ProfileDeps, file: Blob, options: ImportChangesPackOptions = {}): Promise<ImportChangesPackResult> {
  return withArchiveGuard(deps.blobStore, () => importUnguarded(deps, file, options), deps.lock);
}

async function importUnguarded(deps: ProfileDeps, file: Blob, options: ImportChangesPackOptions): Promise<ImportChangesPackResult> {
  const aborted = () => {
    if (options.signal?.aborted) throw options.signal.reason;
  };
  const limits: ArchiveLimits = { ...DEFAULT_LIMITS, ...options.limits };
  options.onProgress?.({ phase: 'preparing' });
  const encrypted = await isEncryptedBackup(file);
  // Before anything else: a wrong password or a file that is not a pack changes nothing.
  const zip = await openBackupBlob(file, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
  const opened = await openChangesPack(zip, { supportedSchemaVersion: SCHEMA_VERSION, limits: options.limits });
  const { manifest } = opened;
  const refuse = (reason: MergeRefusal | null) => {
    if (reason !== null) throw new ChangesPackMergeError(reason, REFUSALS[reason]);
  };
  const address = {
    kind: manifest.kind,
    sourceDeviceId: manifest.source.deviceId,
    targetDeviceId: manifest.target.deviceId,
    since: manifest.since,
    upTo: manifest.upTo,
    ack: manifest.ack,
  };
  refuse(await deps.client.call('checkChangesPack', address));

  const recordBytes = manifest.entries.filter((e) => !e.path.startsWith('blobs/')).reduce((sum, e) => sum + e.size, 0);
  if (recordBytes > (options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES)) {
    throw new ArchiveError('limit-exceeded', 'the changes pack is too large to merge in one go; ask the sender for smaller ones');
  }

  // 2. Every record, validated, before a byte of media is stored.
  aborted();
  const blobs = await readRecords(zip, opened, 'blobs', parsePackBlob, options.signal);
  const profiles = await readRecords(zip, opened, 'profiles', parsePackProfile, options.signal);
  const conversations = await readRecords(zip, opened, 'conversations', parsePackConversation, options.signal);
  const favorites = await readRecords(zip, opened, 'favorites', parsePackFavorite, options.signal);
  const notes = await readRecords(zip, opened, 'notes', parsePackNote, options.signal);
  const tombstones = await readRecords(zip, opened, 'tombstones', parsePackTombstone, options.signal);
  const batches: MergeChangesPackInput['batches'] = [];
  let messageCount = 0;
  for (const item of manifest.entries) {
    const shape = classifyPackPath(item.path)!;
    if (shape.kind !== 'batch') continue;
    let header: ReturnType<typeof parsePackBatchHeader> | undefined;
    const messages: PackMessage[] = [];
    try {
      for await (const line of readPackLines(zip, opened, item.path, options.signal)) {
        if (header === undefined) {
          header = parsePackBatchHeader(line);
          if (header.id !== shape.id) throw new PackRecordError('invalid changes pack record: a batch file names another batch');
        } else messages.push(parsePackMessage(line));
      }
    } catch (error) {
      broken(error);
    }
    if (header === undefined) throw new ArchiveError('integrity', 'a changes pack batch file is empty');
    messageCount += messages.length;
    batches.push({ header, messages });
  }
  const found: ChangesPackCounts = {
    profiles: profiles.length, conversations: conversations.length, batches: batches.length, messages: messageCount,
    favorites: favorites.length, notes: notes.length, tombstones: tombstones.length, blobs: blobs.length,
  };
  for (const name of Object.keys(found) as (keyof ChangesPackCounts)[]) {
    if (found[name] !== manifest.counts[name]) throw new ArchiveError('integrity', 'the changes pack does not hold what its manifest counts');
  }
  // A record cut after `upTo` cannot be in a pack that says it ends there: the watermark would be a lie.
  const seqs = [...profiles, ...conversations, ...favorites, ...notes, ...tombstones, ...batches.map((b) => b.header)].map((r) => r.seq);
  if (seqs.some((seq) => seq > manifest.upTo)) throw new ArchiveError('integrity', 'the changes pack holds changes newer than it says it covers');
  // The blob records and the files under blobs/ are the same set, with the sizes the records name.
  const listed = new Map<string, PackBlob>(blobs.map((b) => [b.sha256, b]));
  const carried = manifest.entries.filter((e) => e.path.startsWith('blobs/'));
  if (listed.size !== blobs.length || listed.size !== carried.length || carried.some((e) => listed.get(e.sha256)?.size !== e.size)) {
    throw new ArchiveError('integrity', 'the media listed by the changes pack are not the media it carries');
  }

  // 3. Media, alongside what the library has (a hash it holds is not written again).
  const written: string[] = [];
  const dropWritten = async () => {
    let left = 0;
    for (const sha256 of written) if (!(await deps.blobStore.delete(sha256).then(() => true, () => false))) left++;
    return left;
  };
  try {
    options.onProgress?.({ phase: 'media', done: 0, total: carried.length });
    let done = 0;
    for (const item of carried) {
      aborted();
      const have = await deps.blobStore.has(item.sha256);
      if (!have) {
        const failure: { error?: ArchiveError } = {};
        const stream = guardedStream(zip, opened.byName.get(item.path)!, { size: item.size, maxBytes: limits.maxEntryBytes, sha256: item.sha256 }, failure);
        let stored: { sha256: string; size: number };
        try {
          stored = await deps.blobStore.put(stream);
        } catch (cause) {
          throw failure.error ?? new ArchiveError('storage', 'could not store a media file', { cause });
        }
        written.push(stored.sha256);
        if (stored.sha256 !== item.sha256 || stored.size !== item.size) {
          throw new ArchiveError('integrity', 'a stored media file does not match the manifest');
        }
      }
      options.onProgress?.({ phase: 'media', done: ++done, total: carried.length });
    }

    // 4. The merge: one transaction in the database worker.
    aborted();
    options.onProgress?.({ phase: 'finishing' });
    const result = await deps.client.call('mergeChangesPack', {
      ...address, now: nowOf(deps), blobs, profiles, conversations, batches, favorites, notes, tombstones,
    });
    // Raced with another change of identity or watermark since the early check; the catch removes the files.
    if (result.refused !== null) throw new ChangesPackMergeError(result.refused, REFUSALS[result.refused]);
    await deleteBlobs(deps, result.unreferencedBlobs);
    return {
      kind: manifest.kind,
      sourceDeviceId: manifest.source.deviceId,
      encrypted,
      counts: result.counts,
      conflicts: result.conflicts,
      batchOffers: result.batchOffers,
      peer: result.peer,
    };
  } catch (error) {
    // The merge is one transaction: unless the worker went away without answering (outcome unknown, the
    // database may reference the files), the library is unchanged and so is the store once these are gone.
    const unknown = error instanceof DbError && (error.code === 'closed' || error.code === 'unavailable');
    if (!unknown) {
      const left = await dropWritten();
      if (left > 0 && error instanceof ArchiveError) error.leftoverBlobs = left;
    }
    throw error;
  }
}

/**
 * What a file is, after decrypting it when it is sealed: `changes-pack` (merge it with
 * `importChangesPack`), `backup` (restore it) or `unknown`. A sealed file only says what it is once
 * opened, so this asks for the password like the importers do (`password-required` / `wrong-password`).
 */
export async function detectArchiveFile(
  file: Blob,
  options: { password?: string; limits?: Partial<ArchiveLimits>; onCryptoProgress?: (progress: CryptoProgress) => void; signal?: AbortSignal } = {},
): Promise<{ kind: ArchiveFileKind; encrypted: boolean }> {
  const encrypted = await isEncryptedBackup(file);
  const zip = await openBackupBlob(file, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
  return { kind: await identifyArchiveFile(zip, options.limits), encrypted };
}
