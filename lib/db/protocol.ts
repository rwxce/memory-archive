import type {
  ConversationBounds,
  ConversationDay,
  ConversationMessage,
  ConversationSummary,
  MediaMessageType,
  MessageCursor,
  MessageSource,
  Participant,
  PersonMediaItem,
  PersonTimelineMessage,
  Profile,
  StoredMessage,
} from '../domain/library';
import type { DbErrorData } from './errors';
import type { DbInfo } from './open';
import type {
  ConversationProfileInput,
  CreateConversationInput,
  CreateProfileInput,
  FavoriteScope,
  FindExistingFingerprintsInput,
  ImportBatchRow,
  ImportCandidates,
  ImportCandidatesInput,
  ImportMessagesInput,
  ImportMessagesResult,
  ListImportBatchesInput,
  MoveConversationInput,
  ProfileState,
  SetFavoriteInput,
  SetProfileArchivedInput,
  UndoImportBatchResult,
  UpdateProfileInput,
} from './queries';

/**
 * Messages between the app and the database worker. Everything is plain
 * structured-cloneable data: no class instances, functions or Dates.
 *
 * Conversation filing ops (`moveConversation`, `linkConversationProfile`,
 * `unlinkConversationProfile`) change only `conversation_profiles`; they never
 * touch messages, media or `participants.profile_id` (participant links are
 * independent of how a conversation is filed).
 *
 * One entry per operation: its parameters and its result. The worker only
 * answers these; there is no way to send SQL.
 */
export interface DbOps {
  status: { params: undefined; result: DbInfo };
  createProfile: { params: CreateProfileInput; result: Profile };
  getProfile: { params: { id: string }; result: Profile };
  updateProfile: { params: UpdateProfileInput; result: Profile };
  setProfileArchived: { params: SetProfileArchivedInput; result: Profile };
  listProfiles: { params: { state?: ProfileState } | undefined; result: Profile[] };
  createConversation: { params: CreateConversationInput; result: null };
  listConversations: { params: { profileId?: string } | undefined; result: ConversationSummary[] };
  renameConversation: { params: { conversationId: string; title: string }; result: ConversationSummary };
  moveConversation: { params: MoveConversationInput; result: ConversationSummary };
  linkConversationProfile: { params: ConversationProfileInput; result: ConversationSummary };
  unlinkConversationProfile: { params: ConversationProfileInput; result: ConversationSummary };
  listParticipants: { params: { conversationId: string }; result: Participant[] };
  importMessages: { params: ImportMessagesInput; result: ImportMessagesResult };
  findImportCandidates: { params: ImportCandidatesInput; result: ImportCandidates };
  findExistingFingerprints: { params: FindExistingFingerprintsInput; result: string[] };
  listImportBatches: { params: ListImportBatchesInput | undefined; result: ImportBatchRow[] };
  undoImportBatch: { params: { batchId: string }; result: UndoImportBatchResult };
  listBlobHashes: { params: undefined; result: string[] };
  listMessages: {
    params: { conversationId: string; after?: MessageCursor; limit?: number };
    result: StoredMessage[];
  };
  getConversationBounds: { params: { conversationId: string }; result: ConversationBounds };
  countMessages: { params: { conversationId: string }; result: number };
  getMessageWindow: { params: { conversationId: string; offset: number; limit: number }; result: ConversationMessage[] };
  findMessageOffsetByDate: { params: { conversationId: string; date: string }; result: number | null };
  listConversationDays: { params: { conversationId: string }; result: ConversationDay[] };
  getMessageSource: { params: { conversationId: string; messageId: number }; result: MessageSource };
  countPersonMedia: { params: { profileId: string; kinds: MediaMessageType[] }; result: number };
  listPersonMedia: {
    params: { profileId: string; kinds: MediaMessageType[]; offset: number; limit: number };
    result: PersonMediaItem[];
  };
  getPersonTimelineBounds: { params: { profileId: string }; result: ConversationBounds };
  getPersonTimelineWindow: { params: { profileId: string; offset: number; limit: number }; result: PersonTimelineMessage[] };
  findPersonTimelineOffsetByDate: { params: { profileId: string; date: string }; result: number | null };
  listPersonTimelineDays: { params: { profileId: string }; result: ConversationDay[] };
  setFavorite: { params: SetFavoriteInput; result: { messageId: number; isFavorite: boolean } };
  countFavorites: { params: { scope?: FavoriteScope } | undefined; result: number };
  listFavorites: { params: { scope?: FavoriteScope; offset: number; limit: number }; result: PersonTimelineMessage[] };
}

export type DbOpName = keyof DbOps;

export interface DbRequest<K extends DbOpName = DbOpName> {
  /** Correlates the response; unique per client. */
  id: number;
  op: K;
  params: DbOps[K]['params'];
}

export type DbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: DbErrorData };
