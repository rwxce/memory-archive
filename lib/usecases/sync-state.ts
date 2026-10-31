import type { RecordReceivedInput, RecordSentInput, SyncPeer } from '../domain/sync';
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

/** Every device this one has exchanged packs with, most recently active first. */
export function listPeers(deps: LibraryDeps): Promise<SyncPeer[]> {
  return deps.client.call('listSyncPeers', undefined);
}

/** What was exchanged with one device; `null` when nothing was. */
export function getPeerState(deps: LibraryDeps, peerId: string): Promise<SyncPeer | null> {
  return deps.client.call('getSyncPeer', { peerId });
}

/** A changes pack for `peerId` was produced up to `upToSeq` (the pack's `upTo`). Only moves the watermark forward. */
export function recordSent(deps: LibraryDeps, peerId: string, upToSeq: number): Promise<SyncPeer> {
  const input: RecordSentInput = { peerId, upToSeq, now: nowOf(deps) };
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
