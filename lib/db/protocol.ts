import type {
  ConversationBounds,
  ConversationDay,
  ConversationMessage,
  ConversationSummary,
  MediaMessageType,
  MessageCursor,
  MessageSource,
  Note,
  NoteItem,
  NoteTarget,
  Participant,
  PersonMediaItem,
  PersonTimelineMessage,
  Profile,
  SearchIndexStep,
  SearchResult,
  SearchStatus,
  StoredMessage,
} from '../domain/library';
import type { HighlightImportCounts, HighlightCategory, HighlightItem, HighlightMessage } from '../domain/highlights';
import type { BlobRow, DatabaseExport } from './snapshot';
import type { DbErrorData } from './errors';
import type { DbInfo } from './open';
import type { HighlightFilter, HighlightScope, ImportHighlightsInput } from './highlights';
import type { SearchInput } from './search';
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
  NoteScope,
  ProfileState,
  SetFavoriteInput,
  SetNoteInput,
  SetProfileArchivedInput,
  SetProfilePhotoInput,
  SetProfilePhotoResult,
  StorageBreakdown,
  DanglingReference,
  LibraryStats,
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
  setProfilePhoto: { params: SetProfilePhotoInput; result: SetProfilePhotoResult };
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
  getStorageBreakdown: { params: undefined; result: StorageBreakdown };
  /** Counts and bytes for the Backup screen; `searchIndexBytes` is 0 until an index exists. Read-only. */
  getLibraryStats: { params: undefined; result: LibraryStats & { searchIndexBytes: number } };
  /** Media rows in hash order after `after` (exclusive), up to `limit` (1..5000): a long check pages through them. */
  listBlobPage: { params: { after?: string; limit: number }; result: BlobRow[] };
  /** Messages and profile photos whose media hash has no row; `items` capped at `limit`. */
  findDanglingBlobRefs: { params: { limit: number }; result: { total: number; items: DanglingReference[] } };
  /** The whole library as a backup needs it: schema version, SQLite bytes and media list, from one moment. */
  exportDatabase: { params: undefined; result: DatabaseExport };
  /** True when no table holds a row. */
  isLibraryEmpty: { params: undefined; result: boolean };
  /**
   * Loads a backup's database into an EMPTY library, all or nothing (`loadSnapshot`): `constraint`
   * when the library has data, `invalid` / `newer-schema` for a bad snapshot. `blobs` must equal the
   * snapshot's own media list. Replaces the search index (rebuilt on the next search).
   * With `replace: true` a library that has data is accepted: its rows are deleted and the
   * snapshot's inserted in one transaction (all or nothing; the old library survives a failure).
   * `unchangedSince` (replace only) is the SHA-256 of the library bytes the caller backed up; if the
   * library differs now it fails with `changed` and touches nothing.
   */
  restoreDatabase: {
    params: { database: Uint8Array; blobs: BlobRow[]; replace?: boolean; unchangedSince?: string };
    result: null;
  };
  /** Every check `restoreDatabase` runs on a snapshot, without writing anything: `invalid` / `newer-schema` when it would be refused. */
  checkDatabase: { params: { database: Uint8Array; blobs: BlobRow[] }; result: null };
  listMessages: {
    params: { conversationId: string; after?: MessageCursor; limit?: number };
    result: StoredMessage[];
  };
  getConversationBounds: { params: { conversationId: string }; result: ConversationBounds };
  countMessages: { params: { conversationId: string }; result: number };
  getMessageWindow: { params: { conversationId: string; offset: number; limit: number }; result: ConversationMessage[] };
  findMessageOffsetByDate: { params: { conversationId: string; date: string }; result: number | null };
  findMessageOffsetById: { params: { conversationId: string; messageId: number }; result: number | null };
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
  findPersonTimelineOffsetById: { params: { profileId: string; messageId: number }; result: number | null };
  listPersonTimelineDays: { params: { profileId: string }; result: ConversationDay[] };
  setFavorite: { params: SetFavoriteInput; result: { messageId: number; isFavorite: boolean } };
  countFavorites: { params: { scope?: FavoriteScope } | undefined; result: number };
  getNote: { params: { target: NoteTarget }; result: Note | null };
  setNote: { params: SetNoteInput; result: Note | null };
  countNotes: { params: { scope?: NoteScope } | undefined; result: number };
  listNotes: { params: { scope?: NoteScope; offset: number; limit: number }; result: NoteItem[] };
  importHighlights: { params: ImportHighlightsInput; result: HighlightImportCounts };
  countHighlights: { params: { filter?: HighlightFilter } | undefined; result: number };
  countHighlightsByCategory: { params: { scope?: HighlightScope } | undefined; result: Record<HighlightCategory, number> };
  listHighlights: { params: { filter?: HighlightFilter; offset: number; limit: number }; result: HighlightItem[] };
  listHighlightMessages: { params: { conversationId: string; highlightId: string }; result: HighlightMessage[] };
  deleteHighlight: { params: { conversationId: string; highlightId: string }; result: boolean };
  deleteHighlights: { params: { scope: HighlightScope }; result: number };
  getSearchStatus: { params: undefined; result: SearchStatus };
  stepSearchIndex: { params: { limit?: number } | undefined; result: SearchIndexStep };
  searchMessages: { params: SearchInput; result: SearchResult[] };
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
