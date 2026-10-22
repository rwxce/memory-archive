import type { BlobRow } from './snapshot';
import type { MediaMessageType } from '../domain/library';
import { DbError, toDbError } from './errors';
import type { OpenedDb } from './open';
import type { DbOpName, DbOps, DbRequest, DbResponse } from './protocol';
import {
  createConversation,
  countMessages,
  countPersonMedia,
  countFavorites,
  countNotes,
  createProfile,
  findExistingFingerprints,
  findImportCandidates,
  findMessageOffsetByDate,
  findPersonTimelineOffsetByDate,
  getConversationBounds,
  getMessageSource,
  getMessageWindow,
  getNote,
  getPersonTimelineBounds,
  getPersonTimelineWindow,
  getProfile,
  getStorageBreakdown,
  importMessages,
  linkConversationProfile,
  listConversationDays,
  listConversations,
  listFavorites,
  listNotes,
  listImportBatches,
  listMessages,
  listPersonMedia,
  listPersonTimelineDays,
  listParticipants,
  listProfiles,
  moveConversation,
  renameConversation,
  setFavorite,
  setNote,
  setProfileArchived,
  undoImportBatch,
  unlinkConversationProfile,
  updateProfile,
  type FavoriteScope,
  type NoteScope,
} from './queries';
import { discardSearchIndex, getSearchStatus, searchMessages, stepSearchIndex } from './search';
import { exportDatabase, isLibraryEmpty, listBlobs, loadSnapshot } from './snapshot';

/** Most handlers are synchronous; `restoreDatabase` awaits the scratch database. `serve.ts` runs requests one at a time. */
type Handlers = { [K in DbOpName]: (opened: OpenedDb, params: DbOps[K]['params']) => DbOps[K]['result'] | Promise<DbOps[K]['result']> };

/** Params come from outside the type system: refuse anything but an object. */
function requireParams(p: unknown): Record<string, unknown> {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new DbError('invalid', 'params must be an object');
  return p as Record<string, unknown>;
}

const HANDLERS: Handlers = {
  status: ({ info }) => info,
  createProfile: ({ db }, p) => createProfile(db, p),
  getProfile: ({ db }, p) => getProfile(db, requireParams(p).id as string),
  updateProfile: ({ db }, p) => updateProfile(db, p),
  setProfileArchived: ({ db }, p) => setProfileArchived(db, p),
  listProfiles: ({ db }, p) => listProfiles(db, p === undefined ? {} : requireParams(p)),
  createConversation: ({ db }, p) => {
    createConversation(db, p);
    return null;
  },
  listConversations: ({ db }, p) => listConversations(db, p === undefined ? {} : requireParams(p)),
  renameConversation: ({ db }, p) => renameConversation(db, p),
  moveConversation: ({ db }, p) => moveConversation(db, p),
  linkConversationProfile: ({ db }, p) => linkConversationProfile(db, p),
  unlinkConversationProfile: ({ db }, p) => unlinkConversationProfile(db, p),
  listParticipants: ({ db }, p) => listParticipants(db, requireParams(p).conversationId as string),
  importMessages: ({ db }, p) => importMessages(db, p),
  findImportCandidates: ({ db }, p) => findImportCandidates(db, p),
  findExistingFingerprints: ({ db }, p) => findExistingFingerprints(db, p),
  listImportBatches: ({ db }, p) => listImportBatches(db, p === undefined ? {} : requireParams(p)),
  undoImportBatch: ({ db }, p) => {
    const batchId = requireParams(p).batchId as string;
    // First: the text of the messages about to go must not outlive them in the search index.
    discardSearchIndex(db);
    return undoImportBatch(db, batchId);
  },
  listBlobHashes: ({ db }) => listBlobs(db).map((b) => b.sha256),
  getStorageBreakdown: ({ db }) => getStorageBreakdown(db),
  exportDatabase: ({ db }) => exportDatabase(db),
  isLibraryEmpty: ({ db }) => isLibraryEmpty(db),
  restoreDatabase: async ({ db }, p) => {
    const params = requireParams(p);
    if (!(params.database instanceof Uint8Array) || !Array.isArray(params.blobs)) {
      throw new DbError('invalid', 'database must be bytes and blobs a list');
    }
    if (!isLibraryEmpty(db)) throw new DbError('constraint', 'the library already has data');
    await loadSnapshot(db, params.database, { expectBlobs: params.blobs as BlobRow[] });
    return null;
  },
  listMessages: ({ db }, p) => {
    const params = requireParams(p);
    return listMessages(db, params.conversationId as string, {
      after: params.after as DbOps['listMessages']['params']['after'],
      limit: params.limit as number | undefined,
    });
  },
  getConversationBounds: ({ db }, p) => getConversationBounds(db, requireParams(p).conversationId as string),
  countMessages: ({ db }, p) => countMessages(db, requireParams(p).conversationId as string),
  getMessageWindow: ({ db }, p) => {
    const params = requireParams(p);
    return getMessageWindow(db, params.conversationId as string, params.offset as number, params.limit as number);
  },
  findMessageOffsetByDate: ({ db }, p) => {
    const params = requireParams(p);
    return findMessageOffsetByDate(db, params.conversationId as string, params.date as string);
  },
  listConversationDays: ({ db }, p) => listConversationDays(db, requireParams(p).conversationId as string),
  getMessageSource: ({ db }, p) => {
    const params = requireParams(p);
    return getMessageSource(db, params.conversationId as string, params.messageId as number);
  },
  countPersonMedia: ({ db }, p) => {
    const params = requireParams(p);
    return countPersonMedia(db, params.profileId as string, params.kinds as MediaMessageType[]);
  },
  listPersonMedia: ({ db }, p) => {
    const params = requireParams(p);
    return listPersonMedia(db, params.profileId as string, params.kinds as MediaMessageType[], params.offset as number, params.limit as number);
  },
  getPersonTimelineBounds: ({ db }, p) => getPersonTimelineBounds(db, requireParams(p).profileId as string),
  getPersonTimelineWindow: ({ db }, p) => {
    const params = requireParams(p);
    return getPersonTimelineWindow(db, params.profileId as string, params.offset as number, params.limit as number);
  },
  findPersonTimelineOffsetByDate: ({ db }, p) => {
    const params = requireParams(p);
    return findPersonTimelineOffsetByDate(db, params.profileId as string, params.date as string);
  },
  listPersonTimelineDays: ({ db }, p) => listPersonTimelineDays(db, requireParams(p).profileId as string),
  getSearchStatus: ({ db }) => getSearchStatus(db),
  stepSearchIndex: ({ db }, p) => stepSearchIndex(db, p === undefined ? undefined : (requireParams(p).limit as number | undefined)),
  searchMessages: ({ db }, p) => searchMessages(db, requireParams(p) as unknown as DbOps['searchMessages']['params']),
  setFavorite: ({ db }, p) => setFavorite(db, p),
  countFavorites: ({ db }, p) => countFavorites(db, p === undefined ? undefined : (requireParams(p).scope as FavoriteScope | undefined)),
  listFavorites: ({ db }, p) => {
    const params = requireParams(p);
    return listFavorites(db, params.scope as FavoriteScope | undefined, params.offset as number, params.limit as number);
  },
  getNote: ({ db }, p) => getNote(db, requireParams(p).target as DbOps['getNote']['params']['target']),
  setNote: ({ db }, p) => setNote(db, p),
  countNotes: ({ db }, p) => countNotes(db, p === undefined ? undefined : (requireParams(p).scope as NoteScope | undefined)),
  listNotes: ({ db }, p) => {
    const params = requireParams(p);
    return listNotes(db, params.scope as NoteScope | undefined, params.offset as number, params.limit as number);
  },
};

/**
 * Runs one request against an open database and always returns a response:
 * failures become `{ ok: false, error }` instead of throwing, so one bad
 * request never takes the worker down.
 */
export function handleDbRequest(opened: OpenedDb, request: DbRequest): DbResponse | Promise<DbResponse> {
  const fail = (error: unknown): DbResponse => ({ id: request.id, ok: false, error: toDbError(error).toJSON() });
  try {
    if (!Object.hasOwn(HANDLERS, request.op)) throw new DbError('invalid', 'unknown operation');
    const handler = HANDLERS[request.op] as (opened: OpenedDb, params: unknown) => unknown;
    const result = handler(opened, request.params);
    if (result instanceof Promise) return result.then((value): DbResponse => ({ id: request.id, ok: true, result: value }), fail);
    return { id: request.id, ok: true, result };
  } catch (error) {
    return fail(error);
  }
}
