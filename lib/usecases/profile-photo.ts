import { DbError } from '../db/errors';
import { createSha256 } from '../domain/sha256';
import { isSha256Hex, type Profile } from '../domain/library';
import { makeThumbnail } from '../storage/thumbnail';
import { withArchiveGuard } from './archive-guard';
import { readBlob } from './conversation-view';
import { deleteBlobs } from './import';
import type { ProfileDeps } from './profiles';

/** The longest side of a stored profile photo, in pixels. */
export const PROFILE_PHOTO_MAX_SIDE = 512;

/** The largest picture accepted for decoding. The browser downsizes while decoding, but a hostile file is still bounded. */
export const PROFILE_PHOTO_MAX_INPUT_BYTES = 30 * 1024 * 1024;

function hashOf(bytes: Uint8Array): string {
  const h = createSha256();
  h.update(bytes);
  return h.digestHex();
}

/** Makes the stored picture; `undefined` when it cannot be decoded. The default needs `createImageBitmap` + `OffscreenCanvas`; tests inject one. */
export type DownscaleImage = (image: Blob, maxSide: number) => Promise<Blob | undefined>;

/**
 * Sets (or replaces) a profile's photo from a picture the user chose. The picture is downscaled to
 * at most `PROFILE_PHOTO_MAX_SIDE` and re-encoded (webp, else jpeg), so the original bytes and
 * metadata (EXIF, location) are never stored. The result is a content-addressed blob: the same
 * picture on two profiles is one file. The replaced photo is released when no message and no
 * other profile uses it: its row is removed in the same transaction as the change and its bytes
 * and thumbnail are deleted afterwards (a crash in between leaves an orphan for `sweepOrphanBlobs`).
 *
 * Runs under the archive busy guard, like every write that registers media. Errors are `DbError`s:
 * `invalid` (not an image the browser can decode, empty or too large), `not-found` (no such profile).
 * A failed change leaves the profile as it was and does not keep the new bytes.
 */
export function setProfilePhoto(
  deps: ProfileDeps,
  profileId: string,
  image: Blob,
  downscale: DownscaleImage = makeThumbnail,
): Promise<Profile> {
  return withArchiveGuard(
    deps.blobStore,
    async () => {
      if (image.size === 0) throw new DbError('invalid', 'the picture is empty');
      if (image.size > PROFILE_PHOTO_MAX_INPUT_BYTES) throw new DbError('invalid', 'the picture is too large');
      const small = await downscale(image, PROFILE_PHOTO_MAX_SIDE);
      if (!small || small.size === 0) throw new DbError('invalid', 'the picture could not be read as an image');
      const mime = small.type === 'image/webp' || small.type === 'image/jpeg' ? small.type : null;
      const bytes = new Uint8Array(await small.arrayBuffer());
      // Only a file this call adds may be removed again if the change fails: an existing one
      // is used by something else (nothing else writes meanwhile: guarded).
      const existed = await deps.blobStore.has(hashOf(bytes));
      const { sha256, size } = await deps.blobStore.put(bytes);
      return applyPhoto(deps, profileId, { sha256, size, mime }, !existed);
    },
    deps.lock,
  );
}

/** Removes a profile's photo (no-op when it has none) and releases its file when nothing else uses it. */
export function removeProfilePhoto(deps: ProfileDeps, profileId: string): Promise<Profile> {
  return withArchiveGuard(deps.blobStore, () => applyPhoto(deps, profileId, null, false), deps.lock);
}

async function applyPhoto(deps: ProfileDeps, profileId: string, photo: { sha256: string; size: number; mime: string | null } | null, added: boolean): Promise<Profile> {
  try {
    const { profile, unreferencedBlobs } = await deps.client.call('setProfilePhoto', { id: profileId, photo, now: (deps.now ?? (() => new Date()))().toISOString() });
    await deleteBlobs(deps, unreferencedBlobs);
    return profile;
  } catch (error) {
    // `unavailable` / `closed`: the commit may have happened, so keep the bytes (the sweep decides).
    const definite = error instanceof DbError && error.code !== 'unavailable' && error.code !== 'closed';
    if (added && photo && definite) await deleteBlobs(deps, [photo.sha256]);
    throw error;
  }
}

/** The media type of a stored profile photo, from its first bytes (the stored photo is always webp or jpeg). */
function sniffImageType(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  const riff = String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP';
  return riff ? 'image/webp' : 'application/octet-stream';
}

/**
 * The profile's photo as a `Blob` typed for display (the UI makes an object URL and revokes it
 * when done), or `null` when the profile has none. A photo the database names but the file store
 * lost is `null` too: the screen shows its initials instead of failing. `not-found` for an
 * unknown profile.
 */
export async function getProfilePhoto(deps: Pick<ProfileDeps, 'client' | 'blobStore'>, profileId: string): Promise<Blob | null> {
  const { photoSha256 } = await deps.client.call('getProfile', { id: profileId });
  if (photoSha256 === null || !isSha256Hex(photoSha256)) return null;
  try {
    const raw = await readBlob(deps, photoSha256);
    return new Blob([raw], { type: sniffImageType(new Uint8Array(await raw.slice(0, 12).arrayBuffer())) });
  } catch (error) {
    if (error instanceof DbError && error.code === 'not-found') return null;
    throw error;
  }
}
