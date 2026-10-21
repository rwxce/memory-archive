import type {
  ConversationSummary,
  MessageCursor,
  Participant,
  Profile,
  StoredMessage,
} from '../domain/library';
import type { DbErrorData } from './errors';
import type { DbInfo } from './open';
import type {
  CreateConversationInput,
  CreateProfileInput,
  ImportMessagesInput,
  ImportMessagesResult,
} from './queries';

/**
 * Messages between the app and the database worker. Everything is plain
 * structured-cloneable data: no class instances, functions or Dates.
 *
 * One entry per operation: its parameters and its result. The worker only
 * answers these; there is no way to send SQL.
 */
export interface DbOps {
  status: { params: undefined; result: DbInfo };
  createProfile: { params: CreateProfileInput; result: Profile };
  listProfiles: { params: undefined; result: Profile[] };
  createConversation: { params: CreateConversationInput; result: null };
  listConversations: { params: { profileId?: string } | undefined; result: ConversationSummary[] };
  listParticipants: { params: { conversationId: string }; result: Participant[] };
  importMessages: { params: ImportMessagesInput; result: ImportMessagesResult };
  listMessages: {
    params: { conversationId: string; after?: MessageCursor; limit?: number };
    result: StoredMessage[];
  };
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
