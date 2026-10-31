import type { RecordReceivedInput, RecordSentInput, RecordSentResult, SyncPeer, UnsentChanges } from '../domain/sync';
import { nowOf, type LibraryDeps } from './profiles';

/**
 * Device identity and per-peer watermarks for manual device-to-device sync
 * (`docs/formats/changes-pack.md`). Data layer only: nothing here builds or reads a pack yet, and
 * nothing leaves the device. Failures are `DbError`s (`invalid` for a bad id or watermark).
 */

/** This library's device id, created on first use. A restored or replaced library gets a new one. */
export function getDeviceId(deps: LibraryDeps): Promise<string> {
  return deps.client.call('getDeviceId', undefined);
}

/** This library's device id if it exists already; never creates it (`null` otherwise). For read-only callers. */
export function peekDeviceId(deps: LibraryDeps): Promise<string | null> {
  return deps.client.call('peekDeviceId', undefined);
}

/** Every device this one has exchanged packs with, most recently active first. */
export function listPeers(deps: LibraryDeps): Promise<SyncPeer[]> {
  return deps.client.call('listSyncPeers', undefined);
}

/** Per known peer, how many records a changes pack for it would carry now (0 = nothing new to hand over). */
export function countUnsentChanges(deps: LibraryDeps): Promise<UnsentChanges[]> {
  return deps.client.call('countUnsentChanges', undefined);
}

/** What was exchanged with one device; `null` when nothing was. */
export function getPeerState(deps: LibraryDeps, peerId: string): Promise<SyncPeer | null> {
  return deps.client.call('getSyncPeer', { peerId });
}

/**
 * A changes pack for `peerId` was produced up to `upToSeq` (the pack's `upTo`). With `sinceSeq` (the
 * pack's `since`, for a pack of changes) the watermark moves only if it still equals it; without,
 * it only moves forward.
 */
export function recordSent(deps: LibraryDeps, peerId: string, upToSeq: number, sinceSeq: number | null = null): Promise<RecordSentResult> {
  const input: RecordSentInput = { peerId, upToSeq, sinceSeq, now: nowOf(deps) };
  return deps.client.call('recordSyncSent', input);
}

/**
 * A pack from `peerId` was merged completely. `ackedSeq` is the pack's `ack` (null when absent)
 * and replaces our sent watermark, so a pack that never arrived is sent again.
 */
export function recordReceived(deps: LibraryDeps, peerId: string, upToSeq: number, ackedSeq: number | null): Promise<SyncPeer> {
  const input: RecordReceivedInput = { peerId, upToSeq, ackedSeq, now: nowOf(deps) };
  return deps.client.call('recordSyncReceived', input);
}
