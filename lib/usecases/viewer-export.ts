import { DbError } from '../db/errors';
import { photoDisplayDate, type PhotoCursor } from '../domain/photo';
import { buildViewerData, type ViewerSourceConversation, type ViewerSourcePhoto } from '../exporters/viewer/build';
import type { ViewerData, ViewerMedia, ViewerProfile } from '../exporters/viewer/format';
import type { BlobStore } from '../storage/blob-store';
import { blobSize } from './conversation-media';
import { WINDOW_SIZE } from './conversation-view';
import { listProfilePhotos } from './photo-assign';
import { nowOf, type LibraryDeps } from './profiles';

/**
 * Reads the library into the standalone viewer's data (docs/formats/viewer-data.md). Read-only: it
 * touches neither the database nor the blob store contents. The caller (a later export screen or
 * ZIP writer) copies each `media` entry from the blob store to its `path` and inlines
 * `serializeViewerData(data)` into the HTML.
 *
 * Failures are `DbError`s: `invalid` (no profile, bad or reversed dates), `not-found` (no such profile).
 */

/** What to put in the viewer. Item 22 (export config) fills this in from its screen. */
export interface ViewerSelection {
  /** Profiles whose conversations are exported (a conversation linked to several appears once). */
  profileIds: string[];
  /** Local dates `YYYY-MM-DD`, inclusive; absent or null = open. */
  from?: string | null;
  to?: string | null;
  /**
   * Include the media files; without it the messages keep their file names only and the profiles'
   * assigned photos are left out.
   */
  includeMedia: boolean;
}

export interface ViewerExport {
  data: ViewerData;
  /** Files to copy, from the blob store by `sha256` to `path` (same list as `data.media`). */
  media: ViewerMedia[];
  /** Distinct files the messages and the assigned photos refer to that are not in the blob store (left out, never an error). */
  missingMedia: number;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateBound(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!LOCAL_DATE.test(value)) throw new DbError('invalid', `${field} must be YYYY-MM-DD`);
  return value;
}

export async function buildViewerExport(
  deps: LibraryDeps & { blobStore: BlobStore },
  selection: ViewerSelection,
): Promise<ViewerExport> {
  const ids = [...new Set(selection.profileIds)];
  if (ids.length === 0) throw new DbError('invalid', 'select at least one profile');
  const from = dateBound(selection.from, 'from');
  const to = dateBound(selection.to, 'to');
  if (from !== null && to !== null && from > to) throw new DbError('invalid', 'from must not be after to');

  const profiles: ViewerProfile[] = [];
  const summaries = new Map<string, Awaited<ReturnType<typeof listFor>>[number]>();
  for (const id of ids) {
    const p = await deps.client.call('getProfile', { id });
    profiles.push({ id: p.id, displayName: p.displayName, relationship: p.relationship, description: p.description });
    for (const c of await listFor(deps, id)) summaries.set(c.id, c);
  }
  const selected = new Set(ids);
  profiles.sort(byNameThenId);

  const conversations: ViewerSourceConversation[] = [];
  const hashes = new Set<string>();
  const ordered = [...summaries.values()].sort(
    (a, b) => (a.firstMessageAt ?? '').localeCompare(b.firstMessageAt ?? '') || (a.id < b.id ? -1 : 1),
  );
  for (const c of ordered) {
    const messages = await readMessages(deps, c.id, from, to);
    if (messages.length === 0) continue;
    for (const m of messages) if (m.mediaSha256 !== null) hashes.add(m.mediaSha256);
    const participants = await deps.client.call('listParticipants', { conversationId: c.id });
    conversations.push({
      id: c.id,
      title: c.title,
      source: c.source,
      isGroup: c.isGroup,
      profileIds: c.profileIds.filter((id) => selected.has(id)),
      participants,
      messages,
    });
  }

  // The pictures the person assigned to each selected profile (docs/formats/viewer-data.md).
  let photos: Map<string, ViewerSourcePhoto[]> | undefined;
  if (selection.includeMedia) {
    photos = new Map();
    for (const p of profiles) {
      const list = await readProfilePhotos(deps, p.id, from, to);
      for (const ph of list) hashes.add(ph.sha256);
      photos.set(p.id, list);
    }
  }

  const availableMedia = new Map<string, number>();
  let missingMedia = 0;
  if (selection.includeMedia) {
    for (const sha256 of hashes) {
      const size = await blobSize(deps, sha256);
      if (size === undefined) missingMedia++;
      else availableMedia.set(sha256, size);
    }
  }

  const data = buildViewerData({ now: nowOf(deps), from, to, includeMedia: selection.includeMedia, profiles, conversations, availableMedia, photos });
  return { data, media: data.media, missingMedia };
}

const byNameThenId = (a: ViewerProfile, b: ViewerProfile) => a.displayName.localeCompare(b.displayName) || (a.id < b.id ? -1 : 1);

function listFor(deps: LibraryDeps, profileId: string) {
  return deps.client.call('listConversations', { profileId });
}

/** The conversation's messages whose local date is within `from`..`to`, read in windows. */
async function readMessages(deps: LibraryDeps, conversationId: string, from: string | null, to: string | null) {
  let offset = 0;
  if (from !== null) {
    const start = await deps.client.call('findMessageOffsetByDate', { conversationId, date: from });
    if (start === null) return [];
    offset = start;
  }
  const out = [];
  for (;;) {
    const window = await deps.client.call('getMessageWindow', { conversationId, offset, limit: WINDOW_SIZE });
    for (const m of window) {
      if (to !== null && m.sentAt.slice(0, 10) > to) return out;
      out.push(m);
    }
    if (window.length < WINDOW_SIZE) return out;
    offset += window.length;
  }
}

/** Pictures per page when reading a profile's photos (the most `listPhotoPictures` allows). */
const PHOTO_PAGE = 500;

/**
 * The profile's assigned pictures within `from`..`to`, in the grid's order (newest first, undated
 * last). The day is `photoDisplayDate`'s, read in UTC unless the picture carries the camera's own
 * clock, so the result does not depend on the exporting device's time zone. A picture with no date
 * is kept only when no range is set. Only metadata is held; the bytes are streamed by the writer.
 */
async function readProfilePhotos(deps: LibraryDeps, profileId: string, from: string | null, to: string | null): Promise<ViewerSourcePhoto[]> {
  const out: ViewerSourcePhoto[] = [];
  let cursor: PhotoCursor | null = null;
  do {
    const page = await listProfilePhotos(deps, profileId, { cursor, limit: PHOTO_PAGE });
    for (const pic of page.pictures) {
      if (from !== null || to !== null) {
        const day = photoDisplayDate(pic)?.day;
        if (day === undefined || (from !== null && day < from) || (to !== null && day > to)) continue;
      }
      out.push({
        sha256: pic.sha256,
        kind: pic.kind,
        mime: pic.mime,
        takenAt: pic.takenAt,
        takenOffsetMinutes: pic.takenOffsetMinutes,
        dateSource: pic.dateSource,
        fileName: pic.fileName,
        albums: pic.albums,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}
