import { isSha256Hex, isUuid } from '../domain/library';
import {
  PHOTO_ASSIGN_MAX,
  PHOTO_ASSIGN_PROFILES_MAX,
  PHOTO_PICTURE_ALBUMS_MAX,
  type PhotoCounts,
  type PhotoCursor,
  type PhotoPicture,
  type PhotoPicturePage,
  type PhotoScope,
} from '../domain/photo';
import { DbError } from './errors';
import { PHOTO_PAGE_MAX } from './photos';
import { transaction, type SqlDb, type SqlValue } from './sql';

/**
 * Pictures and the profiles the person assigned them to (`docs/formats/photo-library.md`).
 * A picture is the bytes (`sha256`), seen through every `photo_items` row that holds them.
 * Nothing in this file decides an assignment: `assignPhotos` only records what the caller was told
 * to, and no function derives one from a date, an album or a name.
 */

export const PHOTO_DATES_PAGE_MAX = 5000;

const invalid = (message: string): never => {
  throw new DbError('invalid', message);
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function checkScope(raw: unknown): { where: string; params: SqlValue[] } {
  const s = record(raw ?? { show: 'all' }, 'scope');
  const assigned = (extra: string) => `EXISTS (SELECT 1 FROM photo_profiles a WHERE a.sha256 = photo_items.sha256${extra})`;
  if (s.show === 'all') {
    if (s.profileId !== undefined) invalid('scope profileId goes with assigned');
    return { where: '1', params: [] };
  }
  if (s.show === 'unassigned') {
    if (s.profileId !== undefined) invalid('scope profileId goes with assigned');
    return { where: `NOT ${assigned('')}`, params: [] };
  }
  if (s.show === 'assigned') {
    if (s.profileId === undefined) return { where: assigned(''), params: [] };
    if (!isUuid(s.profileId)) return invalid('scope profileId must be a UUID');
    return { where: assigned(' AND a.profile_id = ?'), params: [s.profileId as string] };
  }
  return invalid('scope show must be all, unassigned or assigned');
}

function checkLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('limit must be a number');
  return Math.min(Math.max(Math.trunc(value), 1), PHOTO_PAGE_MAX);
}

/**
 * One row per picture: the item with the most trustworthy date. The ORDER BY is `betterDate`
 * (`lib/domain/photo.ts`) written as SQL: higher rank of the date source first, then the earlier
 * `taken_at` (a missing one last), the smaller offset, the smaller file name, and `source`/`album`
 * so the choice never depends on insertion order. A test pins both to each other.
 *
 * `sort_key` is where the picture sits in the grid: the wall-clock time at the place of the photo
 * (`taken_at + offset` for an `exif` date with an offset, so a 00:30 photo at +10:00 stays on its own day),
 * otherwise `taken_at` as stored. A picture with no date has a NULL key and comes last. It does not
 * know the viewer's zone, so a `sidecar` or `file-modified` picture can sit up to the viewer's UTC
 * offset away from where `photoDisplayDate` puts it: group by consecutive days, never assume one
 * contiguous run per day.
 */
const BEST = (where: string) => `
  best AS (
    SELECT sha256, kind, mime, taken_at, taken_offset_minutes, date_source, file_name,
           ROW_NUMBER() OVER (
             PARTITION BY sha256
             ORDER BY CASE date_source WHEN 'sidecar' THEN 4 WHEN 'exif' THEN 3 WHEN 'exif-local' THEN 2 WHEN 'file-modified' THEN 1 ELSE 0 END DESC,
                      taken_at IS NULL, taken_at, taken_offset_minutes IS NULL, taken_offset_minutes, file_name, source, album) AS rn
      FROM photo_items WHERE ${where}
  ),
  pics AS (
    SELECT sha256, kind, mime, taken_at, taken_offset_minutes, date_source, file_name,
           CASE WHEN taken_at IS NULL THEN NULL
                WHEN date_source = 'exif' AND taken_offset_minutes IS NOT NULL
                  THEN strftime('%Y-%m-%dT%H:%M:%SZ', taken_at, printf('%+d minutes', taken_offset_minutes))
                ELSE taken_at END AS sort_key
      FROM best WHERE rn = 1
  )`;

function checkCursor(raw: unknown): PhotoCursor | null {
  if (raw === undefined || raw === null) return null;
  const c = record(raw, 'cursor');
  if (!isSha256Hex(c.sha256)) invalid('cursor sha256 must be 64 lowercase hex characters');
  // The sort key has the shape of a `takenAt` (shifted by an offset it can leave the calendar range only at its edges).
  if (c.sortKey !== null && (typeof c.sortKey !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c.sortKey))) invalid('cursor sortKey must be a date or null');
  return { sortKey: c.sortKey as string | null, sha256: c.sha256 as string };
}

export interface ListPhotoPicturesInput {
  scope?: PhotoScope;
  cursor?: PhotoCursor | null;
  /** 1..500. */
  limit: number;
}

interface PicRow {
  sha256: string;
  kind: PhotoPicture['kind'];
  mime: string | null;
  takenAt: string | null;
  takenOffsetMinutes: number | null;
  dateSource: PhotoPicture['dateSource'];
  fileName: string;
  sortKey: string | null;
}

/**
 * Pictures newest first (by `sort_key`, undated last, then by hash so the order is total), one
 * page at a time by keyset: adding or assigning pictures between pages never repeats or skips one
 * that was already past the cursor. Read-only.
 */
export function listPhotoPictures(db: SqlDb, input: ListPhotoPicturesInput): PhotoPicturePage {
  const params = record(input, 'params');
  const scope = checkScope(params.scope);
  const limit = checkLimit(params.limit);
  const cursor = checkCursor(params.cursor);
  let after = '';
  const values: SqlValue[] = [...scope.params];
  if (cursor) {
    if (cursor.sortKey === null) {
      after = 'WHERE sort_key IS NULL AND sha256 > ?';
      values.push(cursor.sha256);
    } else {
      after = 'WHERE sort_key IS NULL OR sort_key < ? OR (sort_key = ? AND sha256 > ?)';
      values.push(cursor.sortKey, cursor.sortKey, cursor.sha256);
    }
  }
  const rows = db.all<PicRow>(
    `WITH ${BEST(scope.where)}
     SELECT sha256, kind, mime, taken_at AS takenAt, taken_offset_minutes AS takenOffsetMinutes, date_source AS dateSource,
            file_name AS fileName, sort_key AS sortKey
       FROM pics ${after}
      ORDER BY sort_key IS NULL, sort_key DESC, sha256 LIMIT ?`,
    [...values, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    pictures: describe(db, page),
    nextCursor: rows.length > limit && last ? { sortKey: last.sortKey, sha256: last.sha256 } : null,
  };
}

/** Adds the album, source and assignment lists to a page of pictures. */
function describe(db: SqlDb, page: PicRow[]): PhotoPicture[] {
  if (page.length === 0) return [];
  const marks = page.map(() => '?').join(', ');
  const hashes = page.map((p) => p.sha256);
  const albums = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const r of db.all<{ sha256: string; album: string; source: string }>(`SELECT sha256, album, source FROM photo_items WHERE sha256 IN (${marks})`, hashes)) {
    counts.set(r.sha256, (counts.get(r.sha256) ?? 0) + 1);
    if (r.album !== '') (albums.get(r.sha256) ?? albums.set(r.sha256, new Set()).get(r.sha256)!).add(r.album);
    (sources.get(r.sha256) ?? sources.set(r.sha256, new Set()).get(r.sha256)!).add(r.source);
  }
  const profiles = new Map<string, string[]>();
  for (const r of db.all<{ sha256: string; profileId: string }>(
    `SELECT sha256, profile_id AS profileId FROM photo_profiles WHERE sha256 IN (${marks}) ORDER BY profile_id`,
    hashes,
  )) {
    (profiles.get(r.sha256) ?? profiles.set(r.sha256, []).get(r.sha256)!).push(r.profileId);
  }
  return page.map(({ sortKey: _sortKey, ...p }) => {
    const names = [...(albums.get(p.sha256) ?? [])].sort();
    return {
      ...p,
      albums: names.slice(0, PHOTO_PICTURE_ALBUMS_MAX),
      albumCount: names.length,
      sources: [...(sources.get(p.sha256) ?? [])].sort(),
      itemCount: counts.get(p.sha256) ?? 0,
      assignedProfileIds: profiles.get(p.sha256) ?? [],
    };
  });
}

/** The picture behind a hash, or null when no item holds it. Read-only. */
export function getPhotoPicture(db: SqlDb, sha256: string): PhotoPicture | null {
  if (!isSha256Hex(sha256)) invalid('sha256 must be 64 lowercase hex characters');
  const rows = db.all<PicRow>(
    `WITH ${BEST('sha256 = ?')}
     SELECT sha256, kind, mime, taken_at AS takenAt, taken_offset_minutes AS takenOffsetMinutes, date_source AS dateSource,
            file_name AS fileName, sort_key AS sortKey
       FROM pics`,
    [sha256],
  );
  return describe(db, rows)[0] ?? null;
}

export interface PhotoDateRow {
  sha256: string;
  takenAt: string | null;
  takenOffsetMinutes: number | null;
  dateSource: PhotoPicture['dateSource'];
}

/**
 * The date fields of every picture in scope, ordered by hash and paged by it (`afterSha256`), for
 * grouping by month in the caller's zone (`listPhotoMonths`). A picture's date is its best item's.
 */
export function listPhotoDates(db: SqlDb, input: { scope?: PhotoScope; afterSha256?: string; limit: number }): PhotoDateRow[] {
  const params = record(input, 'params');
  const scope = checkScope(params.scope);
  if (typeof params.limit !== 'number' || !Number.isFinite(params.limit)) invalid('limit must be a number');
  const limit = Math.min(Math.max(Math.trunc(params.limit as number), 1), PHOTO_DATES_PAGE_MAX);
  if (params.afterSha256 !== undefined && !isSha256Hex(params.afterSha256)) invalid('afterSha256 must be 64 lowercase hex characters');
  return db.all<PhotoDateRow>(
    `WITH ${BEST(scope.where)}
     SELECT sha256, taken_at AS takenAt, taken_offset_minutes AS takenOffsetMinutes, date_source AS dateSource
       FROM pics WHERE sha256 > ? ORDER BY sha256 LIMIT ?`,
    [...scope.params, (params.afterSha256 as string | undefined) ?? '', limit],
  );
}

export function countPhotoPictures(db: SqlDb): PhotoCounts {
  const [row] = db.all<PhotoCounts>(
    `SELECT count(DISTINCT sha256) AS pictures,
            count(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM photo_profiles a WHERE a.sha256 = photo_items.sha256) THEN sha256 END) AS unassigned,
            count(*) AS items
       FROM photo_items`,
  );
  return row;
}

function hashList(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${what} must be a non-empty list`);
  if (value.length > max) return invalid(`${what} has too many entries (at most ${max})`);
  return [...new Set(value as string[])];
}

/** Which of `values` (unique) exist, looked up in chunks. */
function existing(db: SqlDb, sql: (marks: string) => string, values: string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    for (const r of db.all<{ v: string }>(sql(chunk.map(() => '?').join(', ')), chunk)) found.add(r.v);
  }
  return found;
}

export interface AssignPhotosInput {
  /** Pictures (by hash) the person selected, 1..2000. */
  sha256s: string[];
  /** Profiles the person chose, 1..50. */
  profileIds: string[];
  now: string;
}

/** The pictures one profile was given by one call. */
export interface PhotoProfileLinks {
  profileId: string;
  sha256s: string[];
}

/** An undo list longer than this is not returned (see `AssignPhotosResult.fresh`): 5,000 hashes are about 330 KB. */
export const PHOTO_UNDO_MAX = 5000;

export interface AssignPhotosResult {
  /** New links. */
  added: number;
  /** Links that already existed (the same picture and profile): not touched. */
  alreadyThere: number;
  /**
   * Exactly the links this call inserted, per profile (a link that existed is not here), so an undo takes
   * back what this call did and nothing a second tab or an earlier call did. `null` when more than
   * `PHOTO_UNDO_MAX` links were added: the response stays small and the call cannot be undone as a whole.
   */
  fresh: PhotoProfileLinks[] | null;
}

/**
 * Records that the person assigned these pictures to these profiles: every pair, in ONE
 * transaction. Idempotent (a pair that exists is left as it is, with its first `created_at`).
 * `invalid` for malformed or too many entries; `not-found` when a picture is in no item or a
 * profile does not exist, and then nothing is written.
 */
export function assignPhotos(db: SqlDb, input: AssignPhotosInput): AssignPhotosResult {
  const params = record(input, 'params');
  const sha256s = hashList(params.sha256s, 'sha256s', PHOTO_ASSIGN_MAX);
  const profileIds = hashList(params.profileIds, 'profileIds', PHOTO_ASSIGN_PROFILES_MAX);
  if (!sha256s.every(isSha256Hex)) invalid('every sha256 must be 64 lowercase hex characters');
  if (!profileIds.every(isUuid)) invalid('every profile id must be a UUID');
  if (typeof params.now !== 'string' || params.now.length === 0 || params.now.length > 40) invalid('now must be a timestamp');
  return transaction(db, () => {
    if (existing(db, (m) => `SELECT DISTINCT sha256 AS v FROM photo_items WHERE sha256 IN (${m})`, sha256s).size !== sha256s.length) {
      throw new DbError('not-found', 'a picture is not in the photo collection');
    }
    if (existing(db, (m) => `SELECT id AS v FROM profiles WHERE id IN (${m})`, profileIds).size !== profileIds.length) {
      throw new DbError('not-found', 'a profile does not exist');
    }
    let added = 0;
    const fresh: PhotoProfileLinks[] = [];
    for (const profileId of profileIds) {
      const inserted: string[] = [];
      for (const sha256 of sha256s) {
        if (db.run('INSERT OR IGNORE INTO photo_profiles (sha256, profile_id, created_at) VALUES (?, ?, ?)', [sha256, profileId, params.now as string]) > 0) inserted.push(sha256);
      }
      added += inserted.length;
      if (inserted.length > 0) fresh.push({ profileId, sha256s: inserted });
    }
    return { added, alreadyThere: sha256s.length * profileIds.length - added, fresh: added > PHOTO_UNDO_MAX ? null : fresh };
  });
}

export interface UnassignPhotosResult {
  /** Links removed; a picture that was not assigned to the profile counts for nothing. */
  removed: number;
}

/** Takes these pictures out of one profile. Idempotent. `not-found` when the profile does not exist. */
export function unassignPhotos(db: SqlDb, input: { sha256s: string[]; profileId: string }): UnassignPhotosResult {
  const params = record(input, 'params');
  const sha256s = hashList(params.sha256s, 'sha256s', PHOTO_ASSIGN_MAX);
  if (!sha256s.every(isSha256Hex)) invalid('every sha256 must be 64 lowercase hex characters');
  if (!isUuid(params.profileId)) invalid('profile id must be a UUID');
  return transaction(db, () => {
    if (db.all('SELECT 1 FROM profiles WHERE id = ?', [params.profileId as string]).length === 0) throw new DbError('not-found', 'a profile does not exist');
    let removed = 0;
    for (const sha256 of sha256s) {
      removed += db.run('DELETE FROM photo_profiles WHERE sha256 = ? AND profile_id = ?', [sha256, params.profileId as string]);
    }
    return { removed };
  });
}

/**
 * Removes exactly these links (the `fresh` of an `assignPhotos` call) in ONE transaction: all or nothing, so a
 * failure leaves nothing half undone and the same call can be retried. Idempotent; a link that is already gone
 * (another tab took it out) counts for nothing, and a profile that no longer exists is not an error (its links went with it).
 * `invalid` for malformed or too many entries.
 */
export function unassignPhotoLinks(db: SqlDb, input: { links: PhotoProfileLinks[] }): UnassignPhotosResult {
  const params = record(input, 'params');
  if (!Array.isArray(params.links) || params.links.length === 0) invalid('links must be a non-empty list');
  const links = params.links as unknown[];
  if (links.length > PHOTO_ASSIGN_PROFILES_MAX) invalid(`links has too many entries (at most ${PHOTO_ASSIGN_PROFILES_MAX})`);
  const checked = links.map((raw) => {
    const link = record(raw, 'link');
    if (!isUuid(link.profileId)) invalid('profile id must be a UUID');
    const sha256s = hashList(link.sha256s, 'sha256s', PHOTO_ASSIGN_MAX);
    if (!sha256s.every(isSha256Hex)) invalid('every sha256 must be 64 lowercase hex characters');
    return { profileId: link.profileId as string, sha256s };
  });
  return transaction(db, () => {
    let removed = 0;
    for (const { profileId, sha256s } of checked) {
      for (const sha256 of sha256s) removed += db.run('DELETE FROM photo_profiles WHERE sha256 = ? AND profile_id = ?', [sha256, profileId]);
    }
    return { removed };
  });
}
