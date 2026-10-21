import type { DbClient } from '../db/client';
import { DbError } from '../db/errors';
import type { ProfileState } from '../db/queries';
import { isMimeType } from '../domain/profile';
import { isSha256Hex, type BlobRef, type ConversationSummary, type Profile } from '../domain/library';
import type { BlobStore } from '../storage/blob-store';

export type { ProfileState };

/**
 * What the profile and conversation use cases need: the database worker client
 * (UI code never touches `lib/db`), a UUID source and a clock. The last two are
 * injectable so tests are deterministic.
 *
 * Failures are `DbError`s from the worker: `invalid` (bad or out-of-bounds
 * input; text is trimmed, never truncated), `not-found`, `constraint`.
 */
export interface LibraryDeps {
  client: Pick<DbClient, 'call'>;
  newId?: () => string;
  now?: () => Date;
}

/** Profile writes that may carry a photo also need the blob store holding its bytes. */
export interface ProfileDeps extends LibraryDeps {
  blobStore: BlobStore;
}

/**
 * A photo is only a reference to bytes that must already be in the blob store
 * with exactly this size. Checked before the database is called, so a wrong
 * reference leaves no `blobs` row behind: `invalid` (malformed, wrong size,
 * bad media type) or `not-found` (no such blob).
 */
async function assertPhotoStored(deps: ProfileDeps, photo: BlobRef | null | undefined): Promise<void> {
  if (photo === undefined || photo === null) return;
  if (typeof photo !== 'object') throw new DbError('invalid', 'photo must be an object');
  if (!isSha256Hex(photo.sha256)) throw new DbError('invalid', 'photo sha256 must be 64 lowercase hex characters');
  if (photo.mime !== null && !isMimeType(photo.mime)) throw new DbError('invalid', 'photo mime must be a type/subtype media type or null');
  const size = await deps.blobStore.size(photo.sha256);
  if (size === undefined) throw new DbError('not-found', 'photo is not in the blob store');
  if (size !== photo.size) throw new DbError('invalid', 'photo size does not match the stored blob');
}

export const newIdOf = (deps: LibraryDeps) => (deps.newId ?? (() => crypto.randomUUID()))();
export const nowOf = (deps: LibraryDeps) => (deps.now ?? (() => new Date()))().toISOString();

export interface NewProfile {
  displayName: string;
  relationship?: string;
  description?: string;
  /** Photo bytes already stored in the blob store; its hash is the reference. */
  photo?: BlobRef | null;
}

export interface ProfilePatch {
  displayName?: string;
  relationship?: string;
  description?: string;
  /** A new photo replaces the current one; null removes it; absent keeps it. */
  photo?: BlobRef | null;
}

export interface ProfileDetails {
  profile: Profile;
  conversations: ConversationSummary[];
}

export async function createProfile(deps: ProfileDeps, input: NewProfile): Promise<Profile> {
  await assertPhotoStored(deps, input.photo);
  return deps.client.call('createProfile', { ...input, id: newIdOf(deps), now: nowOf(deps) });
}

export async function updateProfile(deps: ProfileDeps, id: string, patch: ProfilePatch): Promise<Profile> {
  await assertPhotoStored(deps, patch.photo);
  return deps.client.call('updateProfile', { ...patch, id, now: nowOf(deps) });
}

/** Hides the profile from the active list. Its conversations and messages stay. */
export function archiveProfile(deps: LibraryDeps, id: string): Promise<Profile> {
  return deps.client.call('setProfileArchived', { id, archived: true, now: nowOf(deps) });
}

export function unarchiveProfile(deps: LibraryDeps, id: string): Promise<Profile> {
  return deps.client.call('setProfileArchived', { id, archived: false, now: nowOf(deps) });
}

/** Active profiles by default; pass `archived` or `all` for the others. */
export function listProfiles(deps: LibraryDeps, state: ProfileState = 'active'): Promise<Profile[]> {
  return deps.client.call('listProfiles', { state });
}

/** A profile with the conversations linked to it (archived profiles included). */
export async function getProfileDetails(deps: LibraryDeps, id: string): Promise<ProfileDetails> {
  const profile = await deps.client.call('getProfile', { id });
  const conversations = await deps.client.call('listConversations', { profileId: id });
  return { profile, conversations };
}
