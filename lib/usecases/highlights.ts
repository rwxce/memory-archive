import { DbError } from '../db/errors';
import type { HighlightFilter, HighlightScope } from '../db/highlights';
import {
  parseFindingsText,
  parseFindings,
  type Findings,
  type FindingsError,
  type HighlightCategory,
  type HighlightImportCounts,
  type HighlightItem,
  type HighlightMessage,
} from '../domain/highlights';
import { WINDOW_SIZE } from './conversation-view';
import { nowOf, type LibraryDeps } from './profiles';

export type { HighlightScope, HighlightFilter };

/**
 * Highlights ("Destacats"): key moments, patterns and messages of interest imported from a
 * `findings.json` (format and validator in `domain/highlights.ts`, workflow in
 * `docs/research-workflow.md`). A highlight belongs to a conversation and points at its messages by
 * fingerprint, so it survives backup, restore and merge; the screen only passes local message ids
 * that `listHighlightMessages` gave it. Failures are `DbError`s: `invalid` (a file that does not
 * validate, bad ids / offset / category, a scope naming both a profile and a conversation) and
 * `not-found` (unknown conversation, profile or highlight).
 */

/** Something that does not match but never stops an import. */
export type FindingsWarning =
  /** The file says the chat had a different number of messages than the conversation has now. */
  | 'message-count-differs'
  /** The message the file calls the first one is not in the conversation. */
  | 'first-message-not-found';

export interface ImportFindingsResult extends HighlightImportCounts {
  /** Soft checks that the file belongs to this conversation; the import has run regardless. */
  warnings: FindingsWarning[];
}

/**
 * Validates the text of a `findings.json` without importing it, so a screen can list what is
 * wrong. Errors carry JSON paths and fixed messages, never file content.
 */
export function checkFindingsText(text: string): { ok: true; findings: Findings } | { ok: false; errors: FindingsError[] } {
  const r = parseFindingsText(text);
  return r.ok ? { ok: true, findings: r.value } : r;
}

/**
 * Imports a findings file (its raw text, or an already parsed `Findings`) into a conversation, all
 * or nothing. Idempotent by highlight id: the same file twice changes nothing (`unchanged`), an
 * edited highlight is `updated`, a new one `imported`. Fingerprints not in the conversation are
 * skipped and counted (`skippedFingerprints`); a highlight left with no known message is skipped
 * and its id listed in `skippedHighlights`. A file that does not validate is `invalid` (use
 * `checkFindingsText` first to show the reasons). The conversation match (message count, first
 * message) only produces `warnings`.
 */
export async function importFindings(deps: LibraryDeps, conversationId: string, input: string | Findings): Promise<ImportFindingsResult> {
  const parsed = typeof input === 'string' ? parseFindingsText(input) : parseFindings(input);
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new DbError('invalid', `invalid findings file: ${first.path || 'file'}: ${first.message}`);
  }
  const { conversation, highlights } = parsed.value;
  const counts = await deps.client.call('importHighlights', { conversationId, highlights, now: nowOf(deps) });

  const warnings: FindingsWarning[] = [];
  const total = await deps.client.call('countMessages', { conversationId });
  if (total !== conversation.messageCount) warnings.push('message-count-differs');
  if (conversation.firstFingerprint !== undefined) {
    const found = await deps.client.call('findExistingFingerprints', { conversationId, fingerprints: [conversation.firstFingerprint] });
    if (found.length === 0) warnings.push('first-message-not-found');
  }
  return { ...counts, warnings };
}

/** How many highlights are visible for the filter (those with no message left in the archive are not counted). */
export function countHighlights(deps: LibraryDeps, filter?: HighlightFilter): Promise<number> {
  return deps.client.call('countHighlights', { filter });
}

/** Visible highlights per category in a scope, for the group headers. */
export function countHighlightsByCategory(deps: LibraryDeps, scope?: HighlightScope): Promise<Record<HighlightCategory, number>> {
  return deps.client.call('countHighlightsByCategory', { scope });
}

/**
 * Highlights at positions `offset`..`offset + limit` (clamped to 1..500), in the order of their
 * earliest message; filter by scope (person, conversation, whole archive) and/or category.
 */
export function listHighlights(
  deps: LibraryDeps,
  filter: HighlightFilter | undefined,
  offset: number,
  limit: number = WINDOW_SIZE,
): Promise<HighlightItem[]> {
  return deps.client.call('listHighlights', { filter, offset, limit });
}

/** The messages of a highlight that are in the archive, in the author's order; `id` opens it in its conversation. */
export function listHighlightMessages(deps: LibraryDeps, conversationId: string, highlightId: string): Promise<HighlightMessage[]> {
  return deps.client.call('listHighlightMessages', { conversationId, highlightId });
}

/** Deletes one highlight; `false` when it was already gone. Importing its file again brings it back. */
export function deleteHighlight(deps: LibraryDeps, conversationId: string, highlightId: string): Promise<boolean> {
  return deps.client.call('deleteHighlight', { conversationId, highlightId });
}
