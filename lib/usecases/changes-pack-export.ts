import { DbError } from '../db/errors';
import type { PackMessage } from '../domain/changes-pack';
import type { SyncPeer } from '../domain/sync';
import { assertCanEncrypt, encryptBackup, type CryptoProgress } from '../exporters/archive/encrypt';
import { APP_NAME, ArchiveError, DEFAULT_LIMITS, blobPath, type ArchiveLimits } from '../exporters/archive/format';
import { changesPackFileName, encryptedChangesPackFileName, type ChangesPackCounts } from '../exporters/changes-pack/format';
import { writeChangesPack } from '../exporters/changes-pack/write';
import { withArchiveGuard } from './archive-guard';
import type { ArchiveProgress } from './archive-core';
import type { ProfileDeps } from './profiles';
import { getDeviceId, recordSent } from './sync-state';

/*
 * Exporting a changes pack (`docs/formats/changes-pack.md`). Like `archive-backup.ts` this reaches
 * the database only through `deps.client` and must stay free of SQLite code (the page bundles it).
 */

/** Messages per request to the database worker. */
const PAGE = 2000;

export interface ExportChangesPackOptions {
  appVersion: string;
  now?: Date;
  /**
   * The device the pack is for. A known peer gets the records changed since the last pack handed
   * over to it (or everything if there was none); `null`/absent is a device not known yet, and gets
   * a full pack that any device can merge.
   */
  peerId?: string | null;
  /** Send everything even to a known peer: the remedy when it refused a pack with a `gap`. */
  full?: boolean;
  limits?: Partial<ArchiveLimits>;
  onProgress?: (progress: ArchiveProgress) => void;
  /** Encrypts the pack with this password (`docs/formats/encrypted-backup.md`). `undefined` = plain ZIP; an empty string is refused. */
  password?: string;
  onCryptoProgress?: (progress: CryptoProgress) => void;
  /** Stops the encryption between chunks; rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface ExportChangesPackResult {
  blob: Blob;
  /** `memory-archive-changes-YYYY-MM-DD-<device>.zip`, or `.mabackup` when encrypted. */
  fileName: string;
  /** Whether the file is password-encrypted. When `false` it holds every changed message and photo readably: the UI marks it private. */
  encrypted: boolean;
  kind: 'changes' | 'full';
  counts: ChangesPackCounts;
  /** The device the pack was cut for, `null` when none was named. */
  peerId: string | null;
  /** This device's id when the pack was cut; `confirmChangesPackDelivered` refuses if it changed since (a restore). */
  sourceDeviceId: string;
  /** The change counter the records were read at: the watermark to record once the person has the file. */
  upTo: number;
  /** The watermark the pack started from (`0` for a full pack): the confirmation only applies while it is unchanged. */
  since: number;
}

/**
 * Builds a changes pack. It writes NOTHING to the library and moves NO watermark: the pack may
 * never reach the other device, so the caller records it with `confirmChangesPackDelivered` only
 * after the file was saved or shared. Cancelling or failing therefore leaves the next pack covering
 * the same changes. Media is held to the backup's limits (`ArchiveLimits`).
 *
 * Imports, undos and backups are kept out for the duration (the archive guard), so every message
 * of every carried batch is still there when it is paged; quick edits (notes, favorites) are not
 * blocked and, if made meanwhile, simply travel in the next pack (they got a number above `upTo`).
 * Rejects with `ArchiveError` (`busy`, `limit-exceeded`, `blob-missing`, `integrity`, `storage`,
 * `password-required`, `encryption-unavailable`) or `DbError` (`invalid` for a bad peer id).
 */
export function exportChangesPack(deps: ProfileDeps, options: ExportChangesPackOptions): Promise<ExportChangesPackResult> {
  return withArchiveGuard(deps.blobStore, () => exportUnguarded(deps, options), deps.lock);
}

async function exportUnguarded(deps: ProfileDeps, options: ExportChangesPackOptions): Promise<ExportChangesPackResult> {
  const now = options.now ?? new Date();
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (options.password !== undefined) assertCanEncrypt(options.password);
  options.onProgress?.({ phase: 'preparing' });
  // Records and `upTo` come from ONE synchronous step in the worker; media checks come after.
  const changes = await deps.client.call('readChangeSet', { peerId: options.peerId ?? null, full: options.full });
  assertSendable(changes.batches.length + changes.blobs.length, changes.blobs, limits);
  for (const blob of changes.blobs) {
    if ((await deps.blobStore.size(blob.sha256)) !== blob.size) {
      throw new ArchiveError('blob-missing', 'a media file referenced by the library is missing or has the wrong size');
    }
  }
  async function* pages(batchId: string): AsyncGenerator<PackMessage[]> {
    for (let after = 0; ; ) {
      const page = await deps.client.call('readBatchMessages', { batchId, after, limit: PAGE });
      if (page.messages.length === 0) return;
      yield page.messages;
      after = page.last;
    }
  }
  const { blob: zip, manifest } = await writeChangesPack({
    app: { name: APP_NAME, version: options.appVersion },
    createdAt: now,
    changes,
    limits,
    batchMessages: pages,
    openBlob: (sha256) => deps.blobStore.open(sha256),
    onProgress: (done, total) => options.onProgress?.({ phase: 'media', done, total }),
  });
  options.onProgress?.({ phase: 'finishing' });
  const common = {
    kind: changes.kind,
    counts: manifest.counts,
    peerId: options.peerId ?? null,
    sourceDeviceId: changes.sourceDeviceId,
    upTo: changes.upTo,
    since: changes.since,
  };
  if (options.password === undefined) {
    return { ...common, blob: zip, fileName: changesPackFileName(now, changes.sourceDeviceId), encrypted: false };
  }
  const sealed = await encryptBackup(zip, options.password, { onProgress: options.onCryptoProgress, signal: options.signal });
  return { ...common, blob: sealed, fileName: encryptedChangesPackFileName(now, changes.sourceDeviceId), encrypted: true };
}

/** A pack must never be written that its own reader would refuse for size: same bounds, from known sizes. */
function assertSendable(entriesBeyondFixed: number, blobs: readonly { size: number }[], limits: ArchiveLimits): void {
  const tooBig = (what: string) => new ArchiveError('limit-exceeded', `the changes are too large for one pack (${what})`);
  if (entriesBeyondFixed + 7 > limits.maxEntries) throw tooBig('too many files');
  let total = 0;
  for (const blob of blobs) {
    if (blob.size > limits.maxEntryBytes) throw tooBig('a media file');
    total += blob.size;
  }
  if (total > limits.maxTotalBytes) throw tooBig('total size');
  const directory = 46 * (entriesBeyondFixed + 7) + blobs.length * blobPath('0'.repeat(64)).length;
  if (directory > limits.maxCentralDirectoryBytes) throw tooBig('too many files');
}

export interface ConfirmChangesPackResult {
  /**
   * `false` when nothing was recorded because the sent watermark moved after the pack was cut (the
   * peer's answer carried an `ack`, or a newer pack was confirmed first). Nothing is lost: the next
   * pack starts from whatever the watermark now says. Always `false` for a pack cut without a peer.
   */
  recorded: boolean;
  /** The peer's state afterwards; `null` for a pack cut without a peer. */
  peer: SyncPeer | null;
}

/**
 * Call once the person has the file (it was saved or handed to the share sheet): records that this
 * device gave the pack to its peer, moving the sent watermark from the pack's `since` to its `upTo`.
 * The move is conditional (compare-and-set) for a pack of changes: if the watermark is no longer
 * at `since` (an `ack` lowered it, or a newer pack was confirmed first) nothing is recorded and the
 * result says so; a full pack, which covers everything, only moves it forward. Does nothing for a
 * pack cut without a peer (`peerId` null: the peer's answer will carry an `ack`). Refuses
 * (`DbError` `invalid`) if the library was restored or replaced since the pack was cut, because its
 * watermarks then describe a library that no longer exists.
 */
export async function confirmChangesPackDelivered(
  deps: ProfileDeps,
  pack: Pick<ExportChangesPackResult, 'peerId' | 'sourceDeviceId' | 'upTo' | 'since' | 'kind'>,
): Promise<ConfirmChangesPackResult> {
  if (pack.peerId === null) return { recorded: false, peer: null };
  if ((await getDeviceId(deps)) !== pack.sourceDeviceId) {
    throw new DbError('invalid', 'the library was restored or replaced after this pack was made; nothing was recorded');
  }
  return recordSent(deps, pack.peerId, pack.upTo, pack.kind === 'full' ? null : pack.since);
}
