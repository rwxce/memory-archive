import type { ConversationSummary } from '../domain/library';
import type { LibraryDeps } from './profiles';

/** A conversation as a list shows it: the summary plus who wrote in it, by the names the source gave. */
export interface ConversationRow extends ConversationSummary {
  /** Distinct, non-blank participant names in the order they were first seen. */
  participants: string[];
}

/** Adds the participant names to conversation summaries (one read per conversation). */
export async function withParticipants(deps: LibraryDeps, summaries: ConversationSummary[]): Promise<ConversationRow[]> {
  return Promise.all(
    summaries.map(async (summary) => {
      const found = await deps.client.call('listParticipants', { conversationId: summary.id });
      const names = new Set<string>();
      for (const { displayName } of found) if (displayName.trim() !== '') names.add(displayName);
      return { ...summary, participants: [...names] };
    }),
  );
}

/** Like `listConversations`, with participant names. */
export async function listConversationRows(deps: LibraryDeps, filter: { profileId?: string } = {}): Promise<ConversationRow[]> {
  return withParticipants(deps, await listConversations(deps, filter));
}

/** All conversations, or those linked to one profile. */
export function listConversations(deps: LibraryDeps, filter: { profileId?: string } = {}): Promise<ConversationSummary[]> {
  return deps.client.call('listConversations', filter);
}

export function renameConversation(deps: LibraryDeps, conversationId: string, title: string): Promise<ConversationSummary> {
  return deps.client.call('renameConversation', { conversationId, title });
}

/**
 * Moves a conversation from one of its profiles to another, atomically, without
 * copying messages or media. Moving to the same profile is a no-op; a missing
 * conversation or profile rejects with `not-found`. A group chat stays a group
 * chat: nothing here changes what it is or who its participants are.
 */
export function moveConversation(
  deps: LibraryDeps,
  conversationId: string,
  fromProfileId: string,
  toProfileId: string,
): Promise<ConversationSummary> {
  return deps.client.call('moveConversation', { conversationId, fromProfileId, toProfileId });
}

/** Also files the conversation under another profile (a group, or two people sharing it). */
export function linkConversationToProfile(deps: LibraryDeps, conversationId: string, profileId: string): Promise<ConversationSummary> {
  return deps.client.call('linkConversationProfile', { conversationId, profileId });
}

/** Removes one profile link; the conversation and its messages stay, possibly unassigned. */
export function unlinkConversationFromProfile(deps: LibraryDeps, conversationId: string, profileId: string): Promise<ConversationSummary> {
  return deps.client.call('unlinkConversationProfile', { conversationId, profileId });
}
