import { DbError } from '../db/errors';
import { PHOTO_DATES_PAGE_MAX, type AssignPhotosResult, type PhotoProfileLinks, type UnassignPhotosResult } from '../db/photo-assign';
import { PHOTO_ASSIGN_MAX, photoDisplayDate, type PhotoCounts, type PhotoCursor, type PhotoPicture, type PhotoPicturePage, type PhotoScope } from '../domain/photo';
import type { BlobStore } from '../storage/blob-store';
import type { ThumbStore } from '../storage/thumb-store';
import { readBlob } from './conversation-view';
import { nowOf, type LibraryDeps } from './profiles';
import { readTileThumbnail } from './tile-image';

/*
 * Assigning photos to profiles (`docs/formats/photo-library.md`). The person selects pictures and
 * chooses the profiles; nothing here picks either by date, album, name or anything else. No
 * function in this file assigns on its own, and there is no "assign all".
 */

type Client = Pick<LibraryDeps, 'client'>;

export interface PhotoPageInput {
  scope?: PhotoScope;
  /** `nextCursor` of the previous page; absent for the first. */
  cursor?: PhotoCursor | null;
  /** 1..500. */
  limit: number;
}

/**
 * The picture grid: one row per picture (the same bytes in two albums or sources are one row),
 * newest first, undated last, paged by cursor. Show a date only through `photoDisplayDate(picture)`.
 */
export const listPhotoPictures = (deps: Client, page: PhotoPageInput): Promise<PhotoPicturePage> => deps.client.call('listPhotoPictures', page);

/** What one profile has been given, in the same order and shape as the grid. */
export const listProfilePhotos = (deps: Client, profileId: string, page: Omit<PhotoPageInput, 'scope'>): Promise<PhotoPicturePage> =>
  deps.client.call('listPhotoPictures', { ...page, scope: { show: 'assigned', profileId } });

/** Total pictures, how many are assigned to nobody, and the item count. */
export const countPhotoPictures = (deps: Client): Promise<PhotoCounts> => deps.client.call('countPhotoPictures');

export const getPhotoPicture = (deps: Client, sha256: string): Promise<PhotoPicture | null> => deps.client.call('getPhotoPicture', { sha256 });

/**
 * Assigns the pictures to the profiles: every pair, one transaction, idempotent. At most
 * `PHOTO_ASSIGN_MAX` pictures per call (a bigger selection is several calls). Rejects with
 * `DbError` `invalid` (malformed, empty, too many) or `not-found` (a picture not in the
 * collection, a profile that does not exist), and then nothing was written.
 */
export const assignPhotos = (deps: Client & Pick<LibraryDeps, 'now'>, input: { sha256s: string[]; profileIds: string[] }): Promise<AssignPhotosResult> =>
  deps.client.call('assignPhotos', { sha256s: input.sha256s, profileIds: input.profileIds, now: nowOf(deps) });

/** Takes the pictures out of one profile; the pictures stay in the collection. Idempotent. */
export const unassignPhotos = (deps: Client, input: { sha256s: string[]; profileId: string }): Promise<UnassignPhotosResult> =>
  deps.client.call('unassignPhotos', input);

/**
 * Takes back exactly these links (the `fresh` of an `assignPhotos` result), all or nothing in one transaction: a
 * failure leaves nothing half undone and the call can be repeated. Links already gone count for nothing.
 */
export const unassignPhotoLinks = (deps: Client, links: PhotoProfileLinks[]): Promise<UnassignPhotosResult> => deps.client.call('unassignPhotoLinks', { links });

export type { PhotoProfileLinks };
export { PHOTO_ASSIGN_MAX };

export interface PhotoMonth {
  /** `YYYY-MM`. */
  month: string;
  count: number;
}

export interface PhotoMonths {
  /** Newest first. */
  months: PhotoMonth[];
  /** Pictures with no date. */
  undated: number;
}

/**
 * Pictures per month, for jumping around the grid. The month of a picture is the month of
 * `photoDisplayDate(picture, zoneOffsetMinutes)` (the single date rule: an `exif` picture with an
 * offset and an `exif-local` one by the camera's own wall clock, the others in the viewer's zone, which is
 * UTC unless `zoneOffsetMinutes(epochMs)` says otherwise, e.g. `(ms) => -new Date(ms).getTimezoneOffset()`).
 * The zone function cannot cross the worker boundary, so the dates are read in pages of the database
 * and folded here.
 */
export async function listPhotoMonths(
  deps: Client,
  options: { scope?: PhotoScope; zoneOffsetMinutes?: (epochMs: number) => number } = {},
): Promise<PhotoMonths> {
  const counts = new Map<string, number>();
  let undated = 0;
  let afterSha256: string | undefined;
  for (;;) {
    const rows = await deps.client.call('listPhotoDates', { scope: options.scope, afterSha256, limit: PHOTO_DATES_PAGE_MAX });
    for (const row of rows) {
      const shown = photoDisplayDate(row, options.zoneOffsetMinutes);
      if (shown === null) undated++;
      else counts.set(shown.day.slice(0, 7), (counts.get(shown.day.slice(0, 7)) ?? 0) + 1);
    }
    if (rows.length < PHOTO_DATES_PAGE_MAX) break;
    afterSha256 = rows[rows.length - 1].sha256;
  }
  return { months: [...counts].map(([month, count]) => ({ month, count })).sort((a, b) => (a.month < b.month ? 1 : -1)), undated };
}

type MediaDeps = Client & { blobStore: BlobStore; thumbStore?: ThumbStore };

async function stored(deps: MediaDeps, sha256: string): Promise<PhotoPicture> {
  const picture = await getPhotoPicture(deps, sha256);
  // Only a picture of the collection is readable through here (not any hash in the store).
  if (!picture) throw new DbError('not-found', 'the picture is not in the photo collection');
  return picture;
}

/**
 * The picture's file for the lightbox: a lazy view of the stored file when the store provides one
 * (a long video costs no memory), else read into memory with the usual size limit. `not-found`
 * when no item holds the hash or the bytes are missing, `too-large` above the in-memory limit.
 */
export async function readPhotoFile(deps: MediaDeps, sha256: string): Promise<Blob> {
  const picture = await stored(deps, sha256);
  return readBlob(deps, sha256, { mime: picture.mime, name: picture.fileName });
}

/**
 * What a grid tile shows: the cached thumbnail, made once from a photo within the decode limit
 * (`readTileThumbnail`), or a small file as it is. `null` when there is nothing small to show (a video, a
 * photo too big to decode for a thumbnail, a format the browser cannot thumbnail): the tile then shows a placeholder
 * and the full file is read only when the person opens the picture. Call it for the tiles near the screen only,
 * never for the whole collection.
 */
export async function readPhotoTile(deps: MediaDeps, sha256: string): Promise<Blob | null> {
  const picture = await stored(deps, sha256);
  if (picture.kind !== 'photo') return null;
  return (await readTileThumbnail(deps, { sha256, mime: picture.mime, name: picture.fileName })) ?? null;
}
