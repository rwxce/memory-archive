import type { MediaMessageType } from '../domain/library';
import { DbError, toDbError } from './errors';
import type { OpenedDb } from './open';
import type { DbOpName, DbOps, DbRequest, DbResponse } from './protocol';
import {
  createConversation,
  countMessages,
  countPersonMedia,
  createProfile,
  findExistingFingerprints,
  findImportCandidates,
  findMessageOffsetByDate,
  findPersonTimelineOffsetByDate,
  getConversationBounds,
  getMessageSource,
  getMessageWindow,
  getPersonTimelineBounds,
  getPersonTimelineWindow,
  getProfile,
  importMessages,
  linkConversationProfile,
  listConversationDays,
  listConversations,
  listImportBatches,
  listMessages,
  listPersonMedia,
  listPersonTimelineDays,
  listParticipants,
  listProfiles,
  moveConversation,
  renameConversation,
  setProfileArchived,
  undoImportBatch,
  unlinkConversationProfile,
  updateProfile,
} from './queries';
import { listBlobs } from './snapshot';

type Handlers = { [K in DbOpName]: (opened: OpenedDb, params: DbOps[K]['params']) => DbOps[K]['result'] };

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
  undoImportBatch: ({ db }, p) => undoImportBatch(db, requireParams(p).batchId as string),
  listBlobHashes: ({ db }) => listBlobs(db).map((b) => b.sha256),
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
};

/**
 * Runs one request against an open database and always returns a response:
 * failures become `{ ok: false, error }` instead of throwing, so one bad
 * request never takes the worker down.
 */
export function handleDbRequest(opened: OpenedDb, request: DbRequest): DbResponse {
  try {
    if (!Object.hasOwn(HANDLERS, request.op)) throw new DbError('invalid', 'unknown operation');
    const handler = HANDLERS[request.op] as (opened: OpenedDb, params: unknown) => unknown;
    return { id: request.id, ok: true, result: handler(opened, request.params) };
  } catch (error) {
    return { id: request.id, ok: false, error: toDbError(error).toJSON() };
  }
}
